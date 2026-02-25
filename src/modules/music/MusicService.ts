import {
  ChannelType,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type StringSelectMenuInteraction,
  type Snowflake,
  type VoiceBasedChannel
} from "discord.js";
import type { Player, Track, UnresolvedTrack } from "lavalink-client";
import type { Logger } from "pino";

import type { CustomPlaylistService } from "../playlists/CustomPlaylistService";
import type { PlaylistTrackInput } from "../playlists/types";
import type { ProviderResolver } from "../providers/ProviderResolver";
import {
  PANEL_BUTTONS,
  PANEL_SELECTS,
  type PanelAction,
  type PanelSelectAction,
  type PanelState
} from "./MusicPanel";
import { LavalinkService, type LavalinkLoadResult, type LavalinkRawTrack } from "./LavalinkService";
import type { GuildSettingsService } from "./GuildSettingsService";
import { displayTrack, formatDuration, toPlaylistTrackInput } from "./trackHelpers";
import type {
  EnqueueResult,
  GuildPlaybackSettings,
  MusicPanelDisplay,
  QueueTrack
} from "./types";

const MAX_PLAYLIST_RESOLVE_PER_CALL = 101;
const MAX_TRACKS_PER_IMPORT = 101;
const TRACK_ERROR_GRACE_PERIOD_MS = 90_000;
const TRACK_ERROR_FORCE_ADVANCE_DELAY_MS = 4_000;
const PANEL_JUMP_TARGET_LIMIT = 20;
const SESSION_TRACK_HISTORY_LIMIT = 80;
const VOTE_SKIP_RATIO = 0.6;

interface VoteSkipState {
  trackKey: string;
  requiredVotes: number;
  voters: Set<string>;
}

interface SessionTrackRecord {
  title: string;
  author: string;
  durationMs: number;
  query: string;
  url?: string;
  requesterId?: string;
  playedAt: number;
}

interface GuildSessionState {
  startedAt: number;
  tracksPlayed: number;
  totalDurationMs: number;
  requesterCounts: Map<string, number>;
  recentTracks: SessionTrackRecord[];
}

export class MusicService {
  private readonly pendingDestroyTimers = new Map<string, NodeJS.Timeout>();
  private readonly recentTrackErrors = new Map<string, number>();
  private readonly voteSkipByGuild = new Map<string, VoteSkipState>();
  private readonly sessionByGuild = new Map<string, GuildSessionState>();

  public constructor(
    private readonly lavalink: LavalinkService,
    private readonly providers: ProviderResolver,
    private readonly playlistService: CustomPlaylistService,
    private readonly guildSettings: GuildSettingsService,
    private readonly emptyDestroyTimeoutMs: number,
    private readonly selfDeaf: boolean,
    private readonly logger: Logger
  ) {
    this.bindAutoplayHandler();
  }

  public async initialize(clientId: string, username: string): Promise<void> {
    await this.lavalink.initialize(clientId, username);
  }

  public async forwardRawEvent(payload: unknown): Promise<void> {
    await this.lavalink.forwardRawEvent(payload);
  }

  public async fetchMember(interaction: ChatInputCommandInteraction): Promise<GuildMember> {
    if (!interaction.guild) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    return interaction.guild.members.fetch(interaction.user.id);
  }

  public getPlayer(guildId: string): Player | undefined {
    return this.lavalink.manager.getPlayer(guildId);
  }

  public async enqueue(
    interaction: ChatInputCommandInteraction,
    input: string
  ): Promise<EnqueueResult> {
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    if (!this.lavalink.manager.useable) {
      throw new Error("Aucun noeud Lavalink n'est connecte.");
    }

    const voiceChannel = await this.getRequiredUserVoiceChannel(interaction);
    const settings = await this.guildSettings.get(interaction.guildId);
    const player = await this.getOrCreatePlayer(interaction, voiceChannel, settings.volume);
    const resolution = this.providers.resolve(input);

    const result = await player.search(
      resolution.searchQuery,
      this.asRequester(interaction)
    );

    if (result.tracks.length === 0) {
      throw new Error("Aucune musique trouvee pour cette recherche.");
    }

    const tracksToAdd = result.playlist
      ? result.tracks.slice(0, MAX_TRACKS_PER_IMPORT)
      : [result.tracks[0]];
    const filteredTracks = this.filterDuplicateTracks(
      player,
      tracksToAdd as (Track | UnresolvedTrack)[]
    );
    if (filteredTracks.accepted.length === 0) {
      throw new Error("Toutes les pistes detectees sont deja presentes dans la file.");
    }

    await player.queue.add(filteredTracks.accepted as Track[]);

    if (!player.playing && !player.paused) {
      await player.play();
    }

    const firstTrack = result.tracks[0];
    const enqueueResult: EnqueueResult = {
      provider: resolution.provider,
      addedCount: filteredTracks.accepted.length,
      duplicateSkippedCount: filteredTracks.duplicateSkippedCount,
      isPlaylist: Boolean(result.playlist),
      firstTrackTitle: firstTrack?.info.title ?? "Titre inconnu",
      firstTrackAuthor: firstTrack?.info.author ?? "Auteur inconnu",
      firstTrackDurationMs: firstTrack?.info.duration ?? 0
    };

    if (result.playlist?.name) {
      enqueueResult.playlistName = result.playlist.name;
    }

    if (firstTrack?.info.uri) {
      enqueueResult.firstTrackUrl = firstTrack.info.uri;
    }

    if (firstTrack?.info.artworkUrl) {
      enqueueResult.firstTrackArtworkUrl = firstTrack.info.artworkUrl;
    }

    return enqueueResult;
  }

  public async playCustomPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string,
    shuffle: boolean
  ): Promise<{ addedCount: number; requestedCount: number; duplicateSkippedCount: number }> {
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const playlist = await this.playlistService.getPlaylist(interaction.guildId, playlistName);
    if (!playlist) {
      throw new Error(`Playlist introuvable: "${playlistName}".`);
    }

    if (playlist.tracks.length === 0) {
      throw new Error(`La playlist "${playlist.name}" est vide.`);
    }

    const voiceChannel = await this.getRequiredUserVoiceChannel(interaction);
    const settings = await this.guildSettings.get(interaction.guildId);
    const player = await this.getOrCreatePlayer(interaction, voiceChannel, settings.volume);

    const tracks = [...playlist.tracks];
    const selectedTracks = shuffle ? shuffleArray(tracks) : tracks;
    const cappedTracks = selectedTracks.slice(0, MAX_PLAYLIST_RESOLVE_PER_CALL);
    const knownTrackKeys = this.collectTrackKeysForPlayer(player);

    let addedCount = 0;
    let duplicateSkippedCount = 0;
    for (const track of cappedTracks) {
      const result = await player.search(this.providers.resolve(track.query).searchQuery, {
        id: interaction.user.id,
        username: interaction.user.username
      });

      if (result.tracks.length === 0) {
        continue;
      }

      const resolvedTrack = result.tracks[0] as Track | UnresolvedTrack;
      const trackKey = this.getTrackKey(resolvedTrack);
      if (knownTrackKeys.has(trackKey)) {
        duplicateSkippedCount += 1;
        continue;
      }

      knownTrackKeys.add(trackKey);
      await player.queue.add(resolvedTrack as Track);
      addedCount += 1;
    }

    if (addedCount === 0) {
      throw new Error("Aucune piste de la playlist n'a pu etre lue.");
    }

    if (!player.playing && !player.paused) {
      await player.play();
    }

    return {
      addedCount,
      requestedCount: cappedTracks.length,
      duplicateSkippedCount
    };
  }

  public async skip(interaction: ChatInputCommandInteraction): Promise<QueueTrack | null> {
    const player = await this.getRequiredPlayerInSameVoice(interaction);
    await player.skip();
    return player.queue.current;
  }

  public async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await this.getRequiredPlayerInSameVoice(interaction);
    const guildId = interaction.guildId;
    if (!guildId) {
      return;
    }

    const settings = await this.guildSettings.get(guildId);
    await player.stopPlaying(true, false);

    if (!settings.stayInVoice) {
      await player.destroy("Arret via commande");
    }
  }

  public async pause(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await this.getRequiredPlayerInSameVoice(interaction);
    if (player.paused) {
      throw new Error("La lecture est deja en pause.");
    }

    await player.pause();
  }

  public async resume(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await this.getRequiredPlayerInSameVoice(interaction);
    if (!player.paused) {
      throw new Error("La lecture n'est pas en pause.");
    }

    await player.resume();
  }

  public async leave(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await this.getRequiredPlayerInSameVoice(interaction);
    await player.destroy("Deconnexion via commande");
  }

  public async setVolume(
    interaction: ChatInputCommandInteraction,
    volume: number
  ): Promise<number> {
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    if (volume < 1 || volume > 200) {
      throw new Error("Le volume doit etre entre 1 et 200.");
    }

    await this.guildSettings.setVolume(interaction.guildId, volume);
    const player = this.lavalink.manager.getPlayer(interaction.guildId);
    if (player) {
      await player.setVolume(volume);
    }

    return volume;
  }

  public async setAutoplay(
    guildId: string,
    forcedValue?: boolean
  ): Promise<{ enabled: boolean }> {
    const current = await this.guildSettings.get(guildId);
    const enabled = forcedValue ?? !current.autoplay;
    await this.guildSettings.setAutoplay(guildId, enabled);
    return { enabled };
  }

  public async setStayInVoice(
    guildId: string,
    forcedValue?: boolean
  ): Promise<{ enabled: boolean }> {
    const current = await this.guildSettings.get(guildId);
    const enabled = forcedValue ?? !current.stayInVoice;
    await this.guildSettings.setStayInVoice(guildId, enabled);
    return { enabled };
  }

  public async applyFilter(
    interaction: ChatInputCommandInteraction,
    effect: "reset" | "nightcore" | "vaporwave" | "bassboost" | "rock"
  ): Promise<void> {
    const player = await this.getRequiredPlayerInSameVoice(interaction);

    switch (effect) {
      case "reset":
        await player.filterManager.resetFilters();
        return;
      case "nightcore":
        await player.filterManager.toggleNightcore();
        return;
      case "vaporwave":
        await player.filterManager.toggleVaporwave();
        return;
      case "bassboost":
        await player.filterManager.setEQPreset("BassboostMedium");
        return;
      case "rock":
        await player.filterManager.setEQPreset("Rock");
        return;
      default:
        throw new Error("Filtre non supporte.");
    }
  }

  public async saveCurrentTrackToPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string
  ): Promise<QueueTrack> {
    const player = await this.getRequiredPlayerInSameVoice(interaction);
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const current = player.queue.current;
    if (!current) {
      throw new Error("Aucune piste en cours a sauvegarder.");
    }

    await this.playlistService.addTrack(
      interaction.guildId,
      playlistName,
      toPlaylistTrackInput(current, interaction.user.id)
    );
    return current;
  }

  public async saveQueueToPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string
  ): Promise<{ addedCount: number; attemptedCount: number }> {
    const player = await this.getRequiredPlayerInSameVoice(interaction);
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const tracks: QueueTrack[] = [];
    if (player.queue.current) {
      tracks.push(player.queue.current);
    }
    tracks.push(...player.queue.tracks);

    if (tracks.length === 0) {
      throw new Error("La file d'attente est vide.");
    }

    const playlistTracks: PlaylistTrackInput[] = tracks.map((track) =>
      toPlaylistTrackInput(track, interaction.user.id)
    );

    const result = await this.playlistService.addTracks(
      interaction.guildId,
      playlistName,
      playlistTracks
    );

    return {
      addedCount: result.addedCount,
      attemptedCount: playlistTracks.length
    };
  }

  public async addQueryToPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string,
    query: string
  ): Promise<{ addedCount: number; attemptedCount: number; sourceLabel: string }> {
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    if (!this.lavalink.manager.useable) {
      throw new Error("Aucun noeud Lavalink n'est connecte.");
    }

    const resolution = this.providers.resolve(query);
    const loadResult = await this.lavalink.loadTracks(resolution.searchQuery);
    const loadedTracks = this.extractTracksFromLoadResult(loadResult);

    if (loadedTracks.length === 0) {
      throw new Error("Aucune piste valide trouvee pour cette URL/recherche.");
    }

    const cappedTracks = loadedTracks.slice(0, MAX_TRACKS_PER_IMPORT);
    const inputs: PlaylistTrackInput[] = cappedTracks.map((track) =>
      this.toPlaylistTrackInputFromRawTrack(track, interaction.user.id)
    );

    const result = await this.playlistService.addTracks(interaction.guildId, playlistName, inputs);
    return {
      addedCount: result.addedCount,
      attemptedCount: inputs.length,
      sourceLabel: resolution.provider
    };
  }

  public async saveSessionHistoryToPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string,
    maxTracks = 30
  ): Promise<{ addedCount: number; attemptedCount: number; availableCount: number }> {
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const session = this.sessionByGuild.get(interaction.guildId);
    if (!session || session.recentTracks.length === 0) {
      throw new Error("Aucune session recente a sauvegarder.");
    }

    const clamped = Math.max(1, Math.min(101, maxTracks));
    const selected = session.recentTracks.slice(-clamped);
    const playlistTracks: PlaylistTrackInput[] = selected.map((track) => {
      const payload: PlaylistTrackInput = {
        query: track.query,
        title: `${track.title} - ${track.author}`.trim(),
        addedBy: interaction.user.id
      };

      if (track.url) {
        payload.url = track.url;
      }

      return payload;
    });

    const result = await this.playlistService.addTracks(
      interaction.guildId,
      playlistName,
      playlistTracks
    );

    return {
      addedCount: result.addedCount,
      attemptedCount: playlistTracks.length,
      availableCount: session.recentTracks.length
    };
  }

  public getQueueSummary(
    guildId: Snowflake,
    previewCount = 10
  ): { current: string | null; upcoming: string[] } {
    const player = this.lavalink.manager.getPlayer(guildId);
    if (!player) {
      return { current: null, upcoming: [] };
    }

    const current = player.queue.current
      ? `${displayTrack(player.queue.current)} (${formatDuration(player.queue.current.info.duration ?? 0)})`
      : null;

    const upcoming = player.queue.tracks
      .slice(0, previewCount)
      .map(
        (track, index) =>
          `${index + 1}. ${displayTrack(track)} (${formatDuration(track.info.duration ?? 0)})`
      );

    return { current, upcoming };
  }

  public getNowPlaying(guildId: Snowflake): string | null {
    const player = this.lavalink.manager.getPlayer(guildId);
    if (!player?.queue.current) {
      return null;
    }

    const track = player.queue.current;
    return `${displayTrack(track)} (${formatDuration(track.info.duration ?? 0)})`;
  }

  public async getPanelState(guildId: string): Promise<PanelState> {
    const settings = await this.guildSettings.get(guildId);
    const player = this.lavalink.manager.getPlayer(guildId);
    if (!player) {
      return {
        paused: false,
        autoplay: settings.autoplay,
        repeatMode: "off",
        hasPrevious: false
      };
    }

    return {
      paused: player.paused,
      autoplay: settings.autoplay,
      repeatMode: player.repeatMode,
      hasPrevious: player.queue.previous.length > 0
    };
  }

  public async getPanelDisplay(guildId: string): Promise<MusicPanelDisplay | null> {
    const player = this.lavalink.manager.getPlayer(guildId);
    if (!player) {
      return null;
    }

    const focusTrack = player.queue.current ?? player.queue.tracks[0];
    if (!focusTrack) {
      return null;
    }

    const settings = await this.guildSettings.get(guildId);
    const isCurrentTrack = player.queue.current === focusTrack;
    const sourceName = focusTrack.info.sourceName ?? "unknown";
    const display: MusicPanelDisplay = {
      trackTitle: focusTrack.info.title ?? "Titre inconnu",
      trackAuthor: focusTrack.info.author ?? "Auteur inconnu",
      trackDurationMs: focusTrack.info.duration ?? 0,
      trackPositionMs: isCurrentTrack ? Math.max(0, player.position) : 0,
      isPlaying: isCurrentTrack ? player.playing : false,
      isPaused: isCurrentTrack ? player.paused : false,
      accentColor: this.resolvePanelAccentColor(
        sourceName,
        isCurrentTrack ? player.playing : false,
        isCurrentTrack ? player.paused : false
      ),
      sourceName,
      modeInfo: this.buildPanelModeInfo(player, settings),
      playlistInfo: this.buildPanelPlaylistInfo(player),
      queueHealthInfo: this.buildPanelQueueHealthInfo(guildId, player),
      sessionInfo: this.buildPanelSessionInfo(guildId),
      voteSkipInfo: this.buildPanelVoteSkipInfo(player),
      jumpTargets: this.buildJumpTargets(player)
    };

    const trackUrl = this.resolveTrackUrl(focusTrack);
    if (trackUrl) {
      display.trackUrl = trackUrl;
    }

    const artworkUrl = this.resolveTrackArtworkUrl(focusTrack);
    if (artworkUrl) {
      display.trackArtworkUrl = artworkUrl;
    }

    const requestedById = this.extractRequesterId(focusTrack);
    if (requestedById) {
      display.requestedById = requestedById;
    }

    return display;
  }

  public async handlePanelAction(
    interaction: ButtonInteraction
  ): Promise<{ message: string; state?: PanelState; disablePanel?: boolean }> {
    const action = interaction.customId as PanelAction;
    const context = await this.getRequiredPanelContext(interaction);
    const { player, guildId } = context;

    switch (action) {
      case PANEL_BUTTONS.volumeDown: {
        const volume = Math.max(1, player.volume - 10);
        await player.setVolume(volume);
        await this.guildSettings.setVolume(guildId, volume);
        return {
          message: `Volume baisse a ${volume}%.`,
          state: await this.getPanelState(guildId)
        };
      }

      case PANEL_BUTTONS.volumeUp: {
        const volume = Math.min(200, player.volume + 10);
        await player.setVolume(volume);
        await this.guildSettings.setVolume(guildId, volume);
        return {
          message: `Volume monte a ${volume}%.`,
          state: await this.getPanelState(guildId)
        };
      }

      case PANEL_BUTTONS.pauseToggle: {
        if (player.paused) {
          await player.resume();
          return { message: "Lecture reprise.", state: await this.getPanelState(guildId) };
        }

        await player.pause();
        return { message: "Lecture en pause.", state: await this.getPanelState(guildId) };
      }

      case PANEL_BUTTONS.skip: {
        if (!player.queue.current) {
          throw new Error("Aucune piste en cours.");
        }

        if (player.queue.tracks.length === 0) {
          await player.stopPlaying(false, false);
          return {
            message: "Piste passee. La file est maintenant vide.",
            state: await this.getPanelState(guildId)
          };
        }

        await player.skip();
        const nowPlaying = player.queue.current;
        if (!nowPlaying) {
          return {
            message: "Piste passee. La file est maintenant vide.",
            state: await this.getPanelState(guildId)
          };
        }
        return {
          message: `Piste passee. En cours: ${displayTrack(nowPlaying)}.`,
          state: await this.getPanelState(guildId)
        };
      }

      case PANEL_BUTTONS.previous: {
        const previous = await player.queue.shiftPrevious();
        if (!previous) {
          throw new Error("Aucune piste precedente disponible.");
        }

        await player.play({ clientTrack: previous });
        return {
          message: `Retour sur: ${displayTrack(previous)}.`,
          state: await this.getPanelState(guildId)
        };
      }

      case PANEL_BUTTONS.shuffle: {
        await player.queue.shuffle();
        return { message: "File melangee.", state: await this.getPanelState(guildId) };
      }

      case PANEL_BUTTONS.loop: {
        const nextMode = this.nextRepeatMode(player.repeatMode);
        await player.setRepeatMode(nextMode);
        const labels: Record<"off" | "track" | "queue", string> = {
          off: "desactivee",
          track: "piste",
          queue: "file"
        };
        return {
          message: `Boucle ${labels[nextMode]}.`,
          state: await this.getPanelState(guildId)
        };
      }

      case PANEL_BUTTONS.autoplay: {
        const result = await this.setAutoplay(guildId);
        return {
          message: `Lecture auto ${result.enabled ? "activee" : "desactivee"}.`,
          state: await this.getPanelState(guildId)
        };
      }

      case PANEL_BUTTONS.voteSkip: {
        const result = await this.applyVoteSkip(player, context.member);
        return {
          message: result.message,
          state: await this.getPanelState(guildId)
        };
      }

      case PANEL_BUTTONS.playlist: {
        const queue = this.getQueueSummary(guildId, 6);
        if (!queue.current && queue.upcoming.length === 0) {
          return {
            message: "La file d'attente est vide.",
            state: await this.getPanelState(guildId)
          };
        }

        const lines: string[] = [];
        if (queue.current) {
          lines.push(`En cours: ${queue.current}`);
        }
        if (queue.upcoming.length > 0) {
          lines.push("A suivre:");
          lines.push(...queue.upcoming);
        }

        return { message: lines.join("\n"), state: await this.getPanelState(guildId) };
      }

      case PANEL_BUTTONS.stop: {
        const settings = await this.guildSettings.get(guildId);
        await player.stopPlaying(true, false);

        if (!settings.stayInVoice) {
          await player.destroy("Arret via panneau");
          return { message: "Lecture arretee et bot deconnecte.", disablePanel: true };
        }

        return { message: "Lecture arretee et file videe.", state: await this.getPanelState(guildId) };
      }

      default:
        throw new Error("Action du panneau inconnue.");
    }
  }

  public async handlePanelSelectAction(
    interaction: StringSelectMenuInteraction
  ): Promise<{ message: string; state?: PanelState }> {
    const action = interaction.customId as PanelSelectAction;
    const context = await this.getRequiredPanelContext(interaction);
    const { player, guildId } = context;

    switch (action) {
      case PANEL_SELECTS.jump: {
        const selected = interaction.values[0];
        if (!selected) {
          throw new Error("Aucune piste selectionnee.");
        }

        const jumpIndex = Number.parseInt(selected, 10);
        if (!Number.isInteger(jumpIndex)) {
          throw new Error("Cible de saut invalide.");
        }

        if (jumpIndex < 0 || jumpIndex >= player.queue.tracks.length) {
          throw new Error("La piste selectionnee n'est plus disponible.");
        }

        const target = player.queue.tracks[jumpIndex];
        if (!target) {
          throw new Error("La piste selectionnee est introuvable.");
        }

        await player.queue.splice(jumpIndex, 1);
        await player.queue.add(target as Track | UnresolvedTrack, 0);

        if (player.queue.current) {
          await player.skip();
        } else if (!player.playing && !player.paused) {
          await player.play();
        }

        this.voteSkipByGuild.delete(guildId);
        return {
          message: `Jump sur: ${displayTrack(target)}.`,
          state: await this.getPanelState(guildId)
        };
      }

      default:
        throw new Error("Action select du panneau inconnue.");
    }
  }

  private bindAutoplayHandler(): void {
    this.lavalink.manager.on("trackStart", (player, track) => {
      this.clearPendingDestroy(player.guildId);
      this.recentTrackErrors.delete(player.guildId);
      this.voteSkipByGuild.delete(player.guildId);
      this.recordSessionTrack(player.guildId, track as QueueTrack | undefined);
    });

    this.lavalink.manager.on("trackError", (player, track, payload) => {
      const errorMessage = payload.exception?.message ?? "";
      void this.handleTrackError(player, track as QueueTrack | undefined, errorMessage);
    });

    this.lavalink.manager.on("playerDestroy", (player) => {
      this.clearPendingDestroy(player.guildId);
      this.recentTrackErrors.delete(player.guildId);
      this.voteSkipByGuild.delete(player.guildId);
    });

    this.lavalink.manager.on("queueEnd", (player, lastTrack) => {
      this.voteSkipByGuild.delete(player.guildId);
      void this.handleQueueEnd(player, lastTrack as QueueTrack | undefined);
    });
  }

  private async handleTrackError(
    player: Player,
    track: QueueTrack | undefined,
    _message: string
  ): Promise<void> {
    this.markRecentTrackError(player.guildId);

    if (!track) {
      return;
    }

    this.scheduleForceAdvanceAfterTrackError(player.guildId, track);
    await this.scheduleDestroyAfterTrackErrorIfIdle(player.guildId);
  }

  private async handleQueueEnd(player: Player, lastTrack: QueueTrack | undefined): Promise<void> {
    try {
      const settings = await this.guildSettings.get(player.guildId);
      const hadRecentError = this.hasRecentTrackError(player.guildId);

      if (settings.autoplay && lastTrack) {
        const didAutoplay = await this.tryAutoplayFromLastTrack(player, lastTrack);
        if (didAutoplay) {
          return;
        }
      }

      if (settings.stayInVoice) {
        this.logger.info({ guildId: player.guildId }, "Fin de file, connexion vocale conservee");
        return;
      }

      if (player.queue.current || player.queue.tracks.length > 0 || player.playing) {
        this.logger.info(
          { guildId: player.guildId },
          "Fin de file ignoree: des pistes restent presentes sur le lecteur"
        );
        return;
      }

      this.scheduleDestroy(player);
      if (hadRecentError) {
        this.logger.warn(
          { guildId: player.guildId },
          "Fin de file detectee apres erreur recente, minuterie de destruction garde-fou activee"
        );
      }
    } catch (error) {
      this.logger.error({ err: error, guildId: player.guildId }, "Echec du gestionnaire de fin de file");
    }
  }

  private async scheduleDestroyAfterTrackErrorIfIdle(guildId: string): Promise<void> {
    const player = this.lavalink.manager.getPlayer(guildId);
    if (!player) {
      return;
    }

    const settings = await this.guildSettings.get(guildId);
    if (settings.stayInVoice) {
      return;
    }

    if (player.queue.current || player.queue.tracks.length > 0 || player.playing || player.paused) {
      return;
    }

    this.scheduleDestroy(player);
  }

  private async tryAutoplayFromLastTrack(player: Player, lastTrack: QueueTrack): Promise<boolean> {
    const seed = `${lastTrack.info.title ?? ""} ${lastTrack.info.author ?? ""}`.trim();
    if (seed.length === 0) {
      return false;
    }

    const autoplaySources = ["ytsearch"] as const;
    for (const source of autoplaySources) {
      try {
        const search = await player.search(
          {
            query: seed,
            source
          },
          { id: "autoplay", username: "Autoplay" }
        );

        const next =
          search.tracks.find((track) => track.info.identifier !== lastTrack.info.identifier) ??
          search.tracks[0];
        if (!next) {
          continue;
        }

        await player.queue.add(next as Track);
        await player.play();
        this.logger.info({ guildId: player.guildId, source }, "Lecture auto a ajoute une piste");
        return true;
      } catch (error) {
        this.logger.warn(
          { err: error, guildId: player.guildId, source },
          "Lecture auto: echec recherche source"
        );
      }
    }

    return false;
  }

  private scheduleForceAdvanceAfterTrackError(guildId: string, failedTrack: QueueTrack): void {
    const failedIdentifier = failedTrack.info.identifier ?? null;
    const failedTitle = failedTrack.info.title ?? null;
    const failedAuthor = failedTrack.info.author ?? null;

    setTimeout(() => {
      void this.forceAdvanceAfterTrackError(guildId, failedIdentifier, failedTitle, failedAuthor);
    }, TRACK_ERROR_FORCE_ADVANCE_DELAY_MS);
  }

  private async forceAdvanceAfterTrackError(
    guildId: string,
    failedIdentifier: string | null,
    failedTitle: string | null,
    failedAuthor: string | null
  ): Promise<void> {
    try {
      const player = this.lavalink.manager.getPlayer(guildId);
      if (!player || player.paused || player.playing) {
        return;
      }

      const current = player.queue.current;
      if (!current || player.queue.tracks.length === 0) {
        return;
      }

      if (!this.isSameTrack(current, failedIdentifier, failedTitle, failedAuthor)) {
        return;
      }

      await player.skip();
      this.logger.warn(
        { guildId, failedTrack: current.info.title },
        "Piste en erreur passee pour reprendre la file"
      );
    } catch (error) {
      this.logger.warn({ err: error, guildId }, "Impossible de passer la piste apres erreur");
    }
  }

  private isSameTrack(
    current: QueueTrack,
    identifier: string | null,
    title: string | null,
    author: string | null
  ): boolean {
    if (identifier && current.info.identifier) {
      return current.info.identifier === identifier;
    }

    return current.info.title === title && current.info.author === author;
  }

  private markRecentTrackError(guildId: string): void {
    this.recentTrackErrors.set(guildId, Date.now());
  }

  private hasRecentTrackError(guildId: string): boolean {
    const lastErrorAt = this.recentTrackErrors.get(guildId);
    if (!lastErrorAt) {
      return false;
    }

    return Date.now() - lastErrorAt <= TRACK_ERROR_GRACE_PERIOD_MS;
  }

  private isYoutubeSource(sourceName: string | undefined): boolean {
    return sourceName?.toLowerCase().includes("youtube") ?? false;
  }

  private buildPanelModeInfo(player: Player, settings: GuildPlaybackSettings): string {
    const repeatLabel =
      player.repeatMode === "off"
        ? "Arret"
        : player.repeatMode === "track"
          ? "Piste"
          : "File";
    const playbackLabel = player.paused ? "Pause" : player.playing ? "Lecture" : "Pret";

    return [
      `Etat: ${playbackLabel}`,
      `Boucle: ${repeatLabel}`,
      `Autoplay: ${settings.autoplay ? "ON" : "OFF"}`,
      `Mode 24/7: ${settings.stayInVoice ? "ON" : "OFF"}`,
      `Volume: ${player.volume}%`
    ].join("\n");
  }

  private buildPanelPlaylistInfo(player: Player, previewCount = 5): string {
    const lines: string[] = [];

    if (player.queue.current) {
      lines.push(`Now: ${this.formatPanelTrackLine(player.queue.current)}`);
    }

    const preview = player.queue.tracks
      .slice(0, previewCount)
      .map((track, index) => `${index + 1}. ${this.formatPanelTrackLine(track)}`);
    if (preview.length > 0) {
      lines.push("A suivre:");
      lines.push(...preview);
    }

    const remaining = player.queue.tracks.length - preview.length;
    if (remaining > 0) {
      lines.push(`... +${remaining} piste(s)`);
    }

    if (lines.length === 0) {
      return "File vide pour le moment.";
    }

    return this.truncateForEmbedField(lines.join("\n"), 1024);
  }

  private buildPanelQueueHealthInfo(guildId: string, player: Player): string {
    const queueSize = player.queue.tracks.length;
    const { knownDurationMs, hasUnknownDuration } = this.collectRemainingDuration(player);
    const recentError = this.hasRecentTrackError(guildId);

    const healthLabel = recentError ? "Fragile" : "Stable";
    const remaining =
      knownDurationMs > 0
        ? formatDuration(knownDurationMs)
        : hasUnknownDuration
          ? "stream"
          : "0:00";
    const remainingLabel = hasUnknownDuration && knownDurationMs > 0 ? `${remaining} + stream` : remaining;

    return [
      `Etat: ${healthLabel}`,
      `Pistes en attente: ${queueSize}`,
      `Temps restant: ${remainingLabel}`,
      `Erreurs recentes: ${recentError ? "oui" : "non"}`
    ].join("\n");
  }

  private buildPanelSessionInfo(guildId: string): string {
    const session = this.sessionByGuild.get(guildId);
    if (!session) {
      return "Session en attente.\nLance une piste pour demarrer le suivi.";
    }

    const elapsedMs = Math.max(0, Date.now() - session.startedAt);
    const topRequester = this.getTopSessionRequester(session);
    const lastTrack = session.recentTracks.at(-1);

    const lines = [
      `Ouverte: ${formatDuration(elapsedMs)}`,
      `Pistes jouees: ${session.tracksPlayed}`,
      `Temps ecoute: ${formatDuration(Math.max(1, session.totalDurationMs))}`
    ];

    if (topRequester) {
      lines.push(`Top demandeur: <@${topRequester.id}> (${topRequester.count})`);
    } else {
      lines.push("Top demandeur: n/a");
    }

    if (lastTrack) {
      lines.push(`Derniere: ${this.truncateForEmbedField(`${lastTrack.title} - ${lastTrack.author}`, 110)}`);
    }

    return lines.join("\n");
  }

  private buildPanelVoteSkipInfo(player: Player): string {
    const current = player.queue.current;
    if (!current) {
      return "Aucune piste active.";
    }

    const voteState = this.getVoteStateForPlayer(player);
    const votes = voteState?.voters.size ?? 0;
    const requiredVotes = voteState?.requiredVotes ?? 1;

    const voterList =
      voteState && voteState.voters.size > 0
        ? [...voteState.voters].slice(0, 6).map((id) => `<@${id}>`).join(", ")
        : "Aucun vote pour le moment.";

    return [
      `Progression: ${votes}/${requiredVotes}`,
      `Seuil: ${requiredVotes} vote(s)`,
      `Votants: ${voterList}`
    ].join("\n");
  }

  private buildJumpTargets(player: Player): MusicPanelDisplay["jumpTargets"] {
    return player.queue.tracks
      .slice(0, PANEL_JUMP_TARGET_LIMIT)
      .map((track, index) => ({
        value: `${index}`,
        label: `#${index + 1} ${this.truncateForEmbedField(track.info.title ?? "Titre inconnu", 80)}`,
        description: this.truncateForEmbedField(
          `${track.info.author ?? "Auteur inconnu"} • ${formatDuration(track.info.duration ?? 0)}`,
          90
        )
      }));
  }

  private collectRemainingDuration(player: Player): {
    knownDurationMs: number;
    hasUnknownDuration: boolean;
  } {
    const tracks: QueueTrack[] = [];
    if (player.queue.current) {
      tracks.push(player.queue.current);
    }
    tracks.push(...player.queue.tracks);

    let knownDurationMs = 0;
    let hasUnknownDuration = false;
    for (const track of tracks) {
      const duration = track.info.duration ?? 0;
      if (Number.isFinite(duration) && duration > 0) {
        knownDurationMs += duration;
      } else {
        hasUnknownDuration = true;
      }
    }

    return { knownDurationMs, hasUnknownDuration };
  }

  private getTopSessionRequester(
    session: GuildSessionState
  ): { id: string; count: number } | null {
    let top: { id: string; count: number } | null = null;
    for (const [id, count] of session.requesterCounts.entries()) {
      if (!top || count > top.count) {
        top = { id, count };
      }
    }

    return top;
  }

  private async applyVoteSkip(
    player: Player,
    member: GuildMember
  ): Promise<{ message: string }> {
    const current = player.queue.current;
    if (!current) {
      throw new Error("Aucune piste en cours pour voter un skip.");
    }

    const eligibleVoters = this.getEligibleVoteCount(member);
    const requiredVotes = this.computeRequiredVoteCount(eligibleVoters);
    const voteState = this.getOrCreateVoteSkipState(player, requiredVotes);

    if (voteState.voters.has(member.id)) {
      return {
        message: `Vote deja enregistre (${voteState.voters.size}/${voteState.requiredVotes}).`
      };
    }

    voteState.requiredVotes = requiredVotes;
    voteState.voters.add(member.id);

    if (voteState.voters.size < voteState.requiredVotes) {
      return {
        message: `Vote skip ajoute: ${voteState.voters.size}/${voteState.requiredVotes}.`
      };
    }

    this.voteSkipByGuild.delete(player.guildId);
    await player.skip();

    const nowPlaying = player.queue.current;
    if (!nowPlaying) {
      return { message: "Vote valide. Piste passee, file vide." };
    }

    return {
      message: `Vote valide (${requiredVotes}/${requiredVotes}). Nouvelle piste: ${displayTrack(nowPlaying)}.`
    };
  }

  private getEligibleVoteCount(member: GuildMember): number {
    const voiceMembers = member.voice.channel?.members;
    if (!voiceMembers) {
      return 1;
    }

    let count = 0;
    for (const voiceMember of voiceMembers.values()) {
      if (voiceMember.user.bot) {
        continue;
      }

      count += 1;
    }

    return Math.max(1, count);
  }

  private computeRequiredVoteCount(eligibleVoters: number): number {
    if (eligibleVoters <= 1) {
      return 1;
    }

    return Math.max(2, Math.ceil(eligibleVoters * VOTE_SKIP_RATIO));
  }

  private getOrCreateVoteSkipState(player: Player, requiredVotes: number): VoteSkipState {
    const current = player.queue.current;
    if (!current) {
      throw new Error("Aucune piste active.");
    }

    const trackKey = this.getTrackKey(current);
    const existing = this.voteSkipByGuild.get(player.guildId);
    if (existing && existing.trackKey === trackKey) {
      return existing;
    }

    const created: VoteSkipState = {
      trackKey,
      requiredVotes: Math.max(1, requiredVotes),
      voters: new Set<string>()
    };
    this.voteSkipByGuild.set(player.guildId, created);
    return created;
  }

  private getVoteStateForPlayer(player: Player): VoteSkipState | null {
    const current = player.queue.current;
    if (!current) {
      return null;
    }

    const existing = this.voteSkipByGuild.get(player.guildId);
    if (!existing) {
      return null;
    }

    const currentTrackKey = this.getTrackKey(current);
    if (existing.trackKey !== currentTrackKey) {
      this.voteSkipByGuild.delete(player.guildId);
      return null;
    }

    return existing;
  }

  private recordSessionTrack(guildId: string, track: QueueTrack | undefined): void {
    if (!track) {
      return;
    }

    const session = this.getOrCreateSessionState(guildId);
    const durationMs =
      Number.isFinite(track.info.duration) && (track.info.duration ?? 0) > 0
        ? track.info.duration ?? 0
        : 0;

    session.tracksPlayed += 1;
    session.totalDurationMs += durationMs;

    const requesterId = this.extractRequesterId(track);
    if (requesterId) {
      session.requesterCounts.set(requesterId, (session.requesterCounts.get(requesterId) ?? 0) + 1);
    }

    const record: SessionTrackRecord = {
      title: track.info.title ?? "Titre inconnu",
      author: track.info.author ?? "Auteur inconnu",
      durationMs,
      query:
        track.info.uri?.trim() ||
        `${track.info.title ?? ""} ${track.info.author ?? ""}`.trim() ||
        track.info.identifier ||
        "inconnu",
      playedAt: Date.now()
    };

    if (track.info.uri) {
      record.url = track.info.uri;
    }
    if (requesterId) {
      record.requesterId = requesterId;
    }

    session.recentTracks.push(record);
    if (session.recentTracks.length > SESSION_TRACK_HISTORY_LIMIT) {
      session.recentTracks.splice(0, session.recentTracks.length - SESSION_TRACK_HISTORY_LIMIT);
    }
  }

  private getOrCreateSessionState(guildId: string): GuildSessionState {
    const existing = this.sessionByGuild.get(guildId);
    if (existing) {
      return existing;
    }

    const created: GuildSessionState = {
      startedAt: Date.now(),
      tracksPlayed: 0,
      totalDurationMs: 0,
      requesterCounts: new Map<string, number>(),
      recentTracks: []
    };
    this.sessionByGuild.set(guildId, created);
    return created;
  }

  private extractTracksFromLoadResult(loadResult: LavalinkLoadResult): LavalinkRawTrack[] {
    switch (loadResult.loadType) {
      case "track":
        return loadResult.data ? [loadResult.data] : [];
      case "search":
        return loadResult.data ?? [];
      case "playlist":
        return loadResult.data.tracks ?? [];
      case "error": {
        const message = loadResult.data.message ?? "Erreur Lavalink inconnue.";
        throw new Error(`Echec de chargement des pistes: ${message}`);
      }
      case "empty":
      default:
        return [];
    }
  }

  private toPlaylistTrackInputFromRawTrack(track: LavalinkRawTrack, addedBy: string): PlaylistTrackInput {
    const title = track.info.title?.trim() || "Titre inconnu";
    const author = track.info.author?.trim() || "Auteur inconnu";
    const query = this.resolveTrackQuery(track);

    const payload: PlaylistTrackInput = {
      query,
      title: `${title} - ${author}`.trim(),
      addedBy
    };

    const uri = track.info.uri?.trim();
    if (uri) {
      payload.url = uri;
    }

    return payload;
  }

  private resolveTrackQuery(track: LavalinkRawTrack): string {
    const uri = track.info.uri?.trim();
    if (uri) {
      return uri;
    }

    const identifier = track.info.identifier?.trim();
    const sourceName = track.info.sourceName?.toLowerCase() ?? "";
    if (identifier && sourceName.includes("youtube")) {
      return `https://www.youtube.com/watch?v=${identifier}`;
    }

    const title = track.info.title?.trim() ?? "";
    const author = track.info.author?.trim() ?? "";
    const fallback = `${title} ${author}`.trim();
    return fallback || identifier || "inconnu";
  }

  private collectTrackKeysForPlayer(player: Player): Set<string> {
    const keys = new Set<string>();
    if (player.queue.current) {
      keys.add(this.getTrackKey(player.queue.current));
    }

    for (const queuedTrack of player.queue.tracks) {
      keys.add(this.getTrackKey(queuedTrack));
    }

    return keys;
  }

  private filterDuplicateTracks(
    player: Player,
    tracks: (Track | UnresolvedTrack)[]
  ): { accepted: (Track | UnresolvedTrack)[]; duplicateSkippedCount: number } {
    const knownTrackKeys = this.collectTrackKeysForPlayer(player);
    const accepted: (Track | UnresolvedTrack)[] = [];
    let duplicateSkippedCount = 0;

    for (const track of tracks) {
      const trackKey = this.getTrackKey(track);
      if (knownTrackKeys.has(trackKey)) {
        duplicateSkippedCount += 1;
        continue;
      }

      knownTrackKeys.add(trackKey);
      accepted.push(track);
    }

    return { accepted, duplicateSkippedCount };
  }

  private getTrackKey(track: Track | UnresolvedTrack): string {
    const identifier = track.info.identifier?.trim();
    if (identifier) {
      return `id:${identifier.toLowerCase()}`;
    }

    const title = (track.info.title ?? "").trim().toLowerCase();
    const author = (track.info.author ?? "").trim().toLowerCase();
    const duration = track.info.duration ?? 0;
    return `meta:${title}::${author}::${duration}`;
  }

  private resolvePanelAccentColor(sourceName: string, isPlaying: boolean, isPaused: boolean): number {
    const source = sourceName.toLowerCase();
    const palette: Record<string, number> = {
      youtube: 0xff2d55,
      youtubemusic: 0xff2d55,
      "youtube music": 0xff2d55,
      spotify: 0x1ed760
    };

    const base = palette[source] ?? 0x2b90ff;
    if (isPaused) {
      return this.scaleColor(base, 0.72);
    }

    if (!isPlaying) {
      return this.scaleColor(base, 0.82);
    }

    return base;
  }

  private scaleColor(color: number, factor: number): number {
    const safeFactor = Math.max(0, Math.min(1.5, factor));
    const red = Math.min(255, Math.round(((color >> 16) & 0xff) * safeFactor));
    const green = Math.min(255, Math.round(((color >> 8) & 0xff) * safeFactor));
    const blue = Math.min(255, Math.round((color & 0xff) * safeFactor));
    return (red << 16) | (green << 8) | blue;
  }

  private formatPanelTrackLine(track: QueueTrack): string {
    const text = `${displayTrack(track)} (${formatDuration(track.info.duration ?? 0)})`;
    return this.truncateForEmbedField(text, 130);
  }

  private truncateForEmbedField(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    if (maxLength <= 3) {
      return value.slice(0, maxLength);
    }

    return `${value.slice(0, maxLength - 3)}...`;
  }

  private resolveTrackUrl(track: QueueTrack): string | null {
    const uri = track.info.uri?.trim();
    if (uri) {
      return uri;
    }

    const identifier = track.info.identifier?.trim();
    if (!identifier) {
      return null;
    }

    if (this.isYoutubeSource(track.info.sourceName)) {
      return `https://www.youtube.com/watch?v=${identifier}`;
    }

    return null;
  }

  private resolveTrackArtworkUrl(track: QueueTrack): string | null {
    const artworkUrl = track.info.artworkUrl?.trim();
    if (artworkUrl) {
      return artworkUrl;
    }

    const youtubeId = this.extractYoutubeVideoId(track.info.identifier, track.info.uri);
    if (youtubeId) {
      return `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
    }

    return null;
  }

  private extractRequesterId(track: QueueTrack): string | null {
    const requester = (track as { requester?: unknown }).requester;
    if (!requester || typeof requester !== "object") {
      return null;
    }

    const candidate = (requester as { id?: unknown }).id;
    if (typeof candidate !== "string" || candidate.length === 0) {
      return null;
    }

    return candidate;
  }

  private extractYoutubeVideoId(identifier?: string, uri?: string): string | null {
    if (identifier && this.isLikelyYoutubeId(identifier)) {
      return identifier;
    }

    if (!uri) {
      return null;
    }

    try {
      const parsed = new URL(uri);
      const host = parsed.hostname.toLowerCase();
      if (host === "youtu.be") {
        const pathId = parsed.pathname.replace(/^\/+/, "").split("/")[0];
        if (pathId && this.isLikelyYoutubeId(pathId)) {
          return pathId;
        }
      }

      if (host.endsWith("youtube.com")) {
        const queryId = parsed.searchParams.get("v");
        if (queryId && this.isLikelyYoutubeId(queryId)) {
          return queryId;
        }

        const pathMatch = parsed.pathname.match(/\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/);
        if (pathMatch?.[1]) {
          return pathMatch[1];
        }
      }
    } catch {
      const fallbackMatch = uri.match(/([A-Za-z0-9_-]{11})/);
      if (fallbackMatch?.[1] && this.isLikelyYoutubeId(fallbackMatch[1])) {
        return fallbackMatch[1];
      }
    }

    return null;
  }

  private isLikelyYoutubeId(value: string): boolean {
    return /^[A-Za-z0-9_-]{11}$/.test(value);
  }

  private async getOrCreatePlayer(
    interaction: ChatInputCommandInteraction,
    voiceChannel: VoiceBasedChannel,
    volume: number
  ): Promise<Player> {
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    await this.assertBotVoicePermissions(interaction, voiceChannel);
    await this.assertBotNotInAnotherVoiceChannel(interaction, voiceChannel.id);

    const existingPlayer = this.lavalink.manager.getPlayer(interaction.guildId);
    if (existingPlayer) {
      if (existingPlayer.voiceChannelId && existingPlayer.voiceChannelId !== voiceChannel.id) {
        throw new Error("Rejoins le meme salon vocal que le bot.");
      }

      if (!existingPlayer.connected) {
        await existingPlayer.connect();
      }

      await this.assertBotNotServerMuted(interaction);
      return existingPlayer;
    }

    const player = this.lavalink.manager.createPlayer({
      guildId: interaction.guildId,
      voiceChannelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      selfDeaf: this.selfDeaf,
      volume
    });
    await player.connect();
    await this.assertBotNotServerMuted(interaction);
    return player;
  }

  private async assertBotNotInAnotherVoiceChannel(
    interaction: ChatInputCommandInteraction,
    requestedVoiceChannelId: string
  ): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
    const currentBotVoiceChannelId = me.voice.channelId;
    if (!currentBotVoiceChannelId || currentBotVoiceChannelId === requestedVoiceChannelId) {
      return;
    }

    throw new Error(
      `Le bot est deja actif dans un autre salon vocal (<#${currentBotVoiceChannelId}>).`
    );
  }

  private async getRequiredUserVoiceChannel(
    interaction: ChatInputCommandInteraction
  ): Promise<VoiceBasedChannel> {
    const member = await this.fetchMember(interaction);
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw new Error("Rejoins d'abord un salon vocal.");
    }

    if (voiceChannel.type === ChannelType.GuildStageVoice) {
      throw new Error("Les salons Stage ne sont pas supportes. Utilise un salon vocal classique.");
    }

    return voiceChannel;
  }

  private async getRequiredPlayerInSameVoice(
    interaction: ChatInputCommandInteraction
  ): Promise<Player> {
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const player = this.lavalink.manager.getPlayer(interaction.guildId);
    if (!player) {
      throw new Error("Aucune lecture en cours.");
    }

    const voiceChannel = await this.getRequiredUserVoiceChannel(interaction);
    if (player.voiceChannelId && player.voiceChannelId !== voiceChannel.id) {
      throw new Error("Rejoins le salon vocal du bot pour utiliser cette action.");
    }

    return player;
  }

  private async getRequiredPanelContext(
    interaction: ButtonInteraction | StringSelectMenuInteraction
  ): Promise<{
    guildId: string;
    player: Player;
    member: GuildMember;
  }> {
    if (!interaction.guildId || !interaction.guild) {
      throw new Error("Ce panneau ne peut etre utilise que sur un serveur.");
    }

    const player = this.lavalink.manager.getPlayer(interaction.guildId);
    if (!player) {
      throw new Error("Aucune lecture en cours.");
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const userVoiceId = member.voice.channelId;
    if (!userVoiceId) {
      throw new Error("Rejoins un salon vocal pour utiliser ce panneau.");
    }

    if (player.voiceChannelId && player.voiceChannelId !== userVoiceId) {
      throw new Error("Rejoins le salon vocal du bot pour utiliser ce panneau.");
    }

    return { guildId: interaction.guildId, player, member };
  }

  private asRequester(interaction: ChatInputCommandInteraction): {
    id: string;
    username: string;
  } {
    return {
      id: interaction.user.id,
      username: interaction.user.username
    };
  }

  private async assertBotVoicePermissions(
    interaction: ChatInputCommandInteraction,
    voiceChannel: VoiceBasedChannel
  ): Promise<void> {
    if (!interaction.guild) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
    const permissions = voiceChannel.permissionsFor(me);
    if (!permissions) {
      throw new Error("Impossible de verifier les permissions du bot dans ce salon.");
    }

    const hasConnect = permissions.has(PermissionFlagsBits.Connect);
    const hasSpeak = permissions.has(PermissionFlagsBits.Speak);

    if (!hasConnect || !hasSpeak) {
      throw new Error("Le bot a besoin des permissions `Connect` et `Speak`.");
    }
  }

  private async assertBotNotServerMuted(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!interaction.guild) {
      return;
    }

    const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
    if (me.voice.serverMute) {
      throw new Error("Le bot est mute par le serveur. Retire le mute dans le salon vocal.");
    }
  }

  private scheduleDestroy(player: Player): void {
    this.clearPendingDestroy(player.guildId);

    const timer = setTimeout(() => {
      void this.destroyPlayerIfStillIdle(player.guildId);
    }, this.emptyDestroyTimeoutMs);

    this.pendingDestroyTimers.set(player.guildId, timer);
    this.logger.info(
      { guildId: player.guildId, timeoutMs: this.emptyDestroyTimeoutMs },
      "Suppression du player planifiee apres fin de file"
    );
  }

  private async destroyPlayerIfStillIdle(guildId: string): Promise<void> {
    this.pendingDestroyTimers.delete(guildId);

    const player = this.lavalink.manager.getPlayer(guildId);
    if (!player) {
      return;
    }

    if (player.queue.current || player.queue.tracks.length > 0 || player.playing || player.paused) {
      this.logger.info(
        { guildId },
        "Destruction annulee: le player n'est plus inactif au declenchement du timer"
      );
      return;
    }

    try {
      await player.destroy("Fin de file et inactivite");
    } catch (error) {
      this.logger.warn({ err: error, guildId }, "Echec destruction player inactif");
    }
  }

  private clearPendingDestroy(guildId: string): void {
    const timer = this.pendingDestroyTimers.get(guildId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.pendingDestroyTimers.delete(guildId);
  }

  private nextRepeatMode(currentMode: "off" | "track" | "queue"): "off" | "track" | "queue" {
    if (currentMode === "off") {
      return "track";
    }

    if (currentMode === "track") {
      return "queue";
    }

    return "off";
  }
}

function shuffleArray<T>(array: T[]): T[] {
  for (let index = array.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = array[index];
    const swap = array[swapIndex];
    if (current === undefined || swap === undefined) {
      continue;
    }

    array[index] = swap;
    array[swapIndex] = current;
  }
  return array;
}
