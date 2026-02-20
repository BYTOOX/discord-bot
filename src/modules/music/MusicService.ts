import {
  ChannelType,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Snowflake,
  type VoiceBasedChannel
} from "discord.js";
import type { Player, SearchQuery, Track, UnresolvedTrack } from "lavalink-client";
import type { Logger } from "pino";

import type { CustomPlaylistService } from "../playlists/CustomPlaylistService";
import type { PlaylistTrackInput } from "../playlists/types";
import type { ProviderResolver } from "../providers/ProviderResolver";
import type { ProviderMode } from "../providers/types";
import { PANEL_BUTTONS, type PanelAction, type PanelState } from "./MusicPanel";
import { LavalinkService } from "./LavalinkService";
import type { GuildSettingsService } from "./GuildSettingsService";
import { displayTrack, formatDuration, toPlaylistTrackInput } from "./trackHelpers";
import type { EnqueueResult, QueueTrack } from "./types";

const MAX_PLAYLIST_RESOLVE_PER_CALL = 150;
const TRACK_ERROR_GRACE_PERIOD_MS = 90_000;
const TRACK_ERROR_FORCE_ADVANCE_DELAY_MS = 4_000;
const FALLBACK_GUARD_TTL_MS = 15 * 60 * 1000;
const YOUTUBE_SEARCH_DEGRADED_TTL_MS = 10 * 60 * 1000;
const FALLBACK_QUERY_MAX_LENGTH = 140;
const SEARCH_QUERY_NOISE_WORDS = new Set([
  "official",
  "video",
  "audio",
  "lyrics",
  "lyric",
  "remix",
  "live",
  "clip",
  "topic",
  "version",
  "hd",
  "4k",
  "8k",
  "vf",
  "vost",
  "vostfr",
  "trailer",
  "teaser",
  "bande",
  "annonce"
]);
type FallbackSource = "scsearch" | "ytsearch" | "ytmsearch";

export class MusicService {
  private readonly pendingDestroyTimers = new Map<string, NodeJS.Timeout>();
  private readonly fallbackGuard = new Set<string>();
  private readonly fallbackInProgressGuilds = new Set<string>();
  private readonly recentTrackErrors = new Map<string, number>();
  private readonly youtubeSearchDegradedUntil = new Map<string, number>();

  public constructor(
    private readonly lavalink: LavalinkService,
    private readonly providers: ProviderResolver,
    private readonly playlistService: CustomPlaylistService,
    private readonly guildSettings: GuildSettingsService,
    private readonly emptyDestroyTimeoutMs: number,
    private readonly selfDeaf: boolean,
    private readonly youtubeFallbackSource: FallbackSource,
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
    input: string,
    preferredProvider: ProviderMode = "auto"
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
    const resolution = this.providers.resolve(input, preferredProvider);
    const searchQuery = this.getSearchQueryWithYoutubeDegradation(
      interaction.guildId,
      resolution.searchQuery as SearchQuery
    );

    const result = await player.search(
      searchQuery,
      this.asRequester(interaction)
    );

    if (result.tracks.length === 0) {
      throw new Error("Aucune musique trouvee pour cette recherche.");
    }

    const tracksToAdd = result.playlist ? result.tracks : [result.tracks[0]];
    await player.queue.add(tracksToAdd as Track[]);

    if (!player.playing && !player.paused) {
      await player.play();
    }

    const firstTrack = result.tracks[0];
    const enqueueResult: EnqueueResult = {
      provider: resolution.provider,
      addedCount: tracksToAdd.length,
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
  ): Promise<{ addedCount: number; requestedCount: number }> {
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

    let addedCount = 0;
    for (const track of cappedTracks) {
      const result = await player.search(this.providers.resolve(track.query).searchQuery, {
        id: interaction.user.id,
        username: interaction.user.username
      });

      if (result.tracks.length === 0) {
        continue;
      }

      await player.queue.add(result.tracks[0] as Track);
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
      requestedCount: cappedTracks.length
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

  private bindAutoplayHandler(): void {
    this.lavalink.manager.on("trackStart", (player) => {
      this.clearPendingDestroy(player.guildId);
      this.recentTrackErrors.delete(player.guildId);
    });

    this.lavalink.manager.on("trackError", (player, track, payload) => {
      const errorMessage = payload.exception?.message ?? "";
      void this.handleTrackError(player, track as QueueTrack | undefined, errorMessage);
    });

    this.lavalink.manager.on("playerDestroy", (player) => {
      this.clearPendingDestroy(player.guildId);
      this.recentTrackErrors.delete(player.guildId);
    });

    this.lavalink.manager.on("queueEnd", (player, lastTrack) => {
      void this.handleQueueEnd(player, lastTrack as QueueTrack | undefined);
    });
  }

  private async handleTrackError(
    player: Player,
    track: QueueTrack | undefined,
    message: string
  ): Promise<void> {
    this.markRecentTrackError(player.guildId);

    if (!track) {
      return;
    }

    if (
      this.isYoutubeSource(track.info.sourceName) &&
      this.isHardYoutubePlaybackFailure(message)
    ) {
      this.activateYoutubeSearchDegradedMode(player.guildId);
    }

    this.fallbackInProgressGuilds.add(player.guildId);
    let fallbackAdded = false;
    try {
      fallbackAdded = await this.tryYoutubeFallback(player, track, message);
    } finally {
      this.fallbackInProgressGuilds.delete(player.guildId);
    }

    if (!fallbackAdded) {
      this.scheduleForceAdvanceAfterTrackError(player.guildId, track);
      await this.scheduleDestroyAfterTrackErrorIfIdle(player.guildId);
    }
  }

  private async handleQueueEnd(player: Player, lastTrack: QueueTrack | undefined): Promise<void> {
    try {
      const settings = await this.guildSettings.get(player.guildId);
      const hadRecentError = this.hasRecentTrackError(player.guildId);

      if (this.fallbackInProgressGuilds.has(player.guildId)) {
        this.logger.info(
          { guildId: player.guildId },
          "Fin de file ignoree: recuperation de secours en cours"
        );
        return;
      }

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

  private async tryYoutubeFallback(
    player: Player,
    track: QueueTrack,
    message: string
  ): Promise<boolean> {
    if (!this.shouldTryYoutubeFallback(track.info.sourceName, message)) {
      return false;
    }

    const fallbackKey = `${player.guildId}:${track.info.identifier ?? track.info.title ?? "inconnu"}`;
    if (this.fallbackGuard.has(fallbackKey)) {
      return false;
    }

    this.fallbackGuard.add(fallbackKey);
    setTimeout(() => this.fallbackGuard.delete(fallbackKey), FALLBACK_GUARD_TTL_MS);

    const queryVariants = this.getFallbackQueryVariants(track);
    if (queryVariants.length === 0) {
      return false;
    }

    const hardYoutubeFailure = this.isHardYoutubePlaybackFailure(message);
    const fallbackSources = this.getFallbackSources(hardYoutubeFailure);

    for (const source of fallbackSources) {
      for (const query of queryVariants) {
        try {
          const search = await player.search(
            {
              query,
              source
            },
            { id: "fallback", username: "FallbackAuto" }
          );
          const replacement = this.pickBestFallbackCandidate(
            search.tracks as Track[],
            track,
            hardYoutubeFailure
          );
          if (!replacement) {
            continue;
          }

          await player.queue.add(replacement as Track, 0);
          await this.resumeAfterFallbackReplacement(player, track);

          this.logger.warn(
            {
              guildId: player.guildId,
              failedTrack: track.info.title,
              replacementTrack: replacement.info.title,
              source,
              query
            },
            "Piste de secours ajoutee apres echec YouTube"
          );
          return true;
        } catch (error) {
          this.logger.warn(
            { err: error, guildId: player.guildId, source, query },
            "Source de secours indisponible"
          );
        }
      }
    }

    return false;
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

    const autoplaySources: FallbackSource[] = this.isYoutubeSearchDegradedActive(player.guildId)
      ? ["scsearch", "ytmsearch", "ytsearch"]
      : ["ytmsearch", "ytsearch", "scsearch"];
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

  private getSearchQueryWithYoutubeDegradation(
    guildId: string,
    searchQuery: SearchQuery
  ): SearchQuery {
    const source = this.getSearchSource(searchQuery);
    if (!this.isYoutubeSearchSource(source)) {
      return searchQuery;
    }

    if (!this.isYoutubeSearchDegradedActive(guildId)) {
      return searchQuery;
    }

    return this.withSearchSource(searchQuery, "scsearch");
  }

  private activateYoutubeSearchDegradedMode(guildId: string): void {
    const now = Date.now();
    const current = this.youtubeSearchDegradedUntil.get(guildId);
    const until = now + YOUTUBE_SEARCH_DEGRADED_TTL_MS;

    this.youtubeSearchDegradedUntil.set(guildId, until);
    if (current && current > now) {
      return;
    }

    this.logger.warn(
      { guildId, durationMs: YOUTUBE_SEARCH_DEGRADED_TTL_MS },
      "Mode degrade YouTube active: recherches texte routees vers SoundCloud"
    );
  }

  private isYoutubeSearchDegradedActive(guildId: string): boolean {
    const degradedUntil = this.youtubeSearchDegradedUntil.get(guildId);
    if (!degradedUntil) {
      return false;
    }

    if (Date.now() <= degradedUntil) {
      return true;
    }

    this.youtubeSearchDegradedUntil.delete(guildId);
    return false;
  }

  private getSearchSource(searchQuery: SearchQuery): string | null {
    if (typeof searchQuery === "string") {
      return null;
    }

    const candidate = (searchQuery as { source?: unknown }).source;
    if (typeof candidate !== "string") {
      return null;
    }

    return candidate.toLowerCase();
  }

  private withSearchSource(searchQuery: SearchQuery, source: FallbackSource): SearchQuery {
    if (typeof searchQuery === "string") {
      return { query: searchQuery, source } as SearchQuery;
    }

    return {
      ...(searchQuery as Record<string, unknown>),
      source
    } as SearchQuery;
  }

  private isYoutubeSearchSource(source: string | null): source is "ytsearch" | "ytmsearch" {
    return source === "ytsearch" || source === "ytmsearch";
  }

  private getFallbackSources(hardYoutubeFailure: boolean): FallbackSource[] {
    if (hardYoutubeFailure) {
      return ["scsearch"];
    }

    return [...new Set<FallbackSource>([this.youtubeFallbackSource, "scsearch", "ytsearch"])];
  }

  private getFallbackQueryVariants(track: QueueTrack): string[] {
    const title = track.info.title?.trim() ?? "";
    const author = track.info.author?.trim() ?? "";
    const combined = `${title} ${author}`.trim();
    if (!combined) {
      return [];
    }

    const normalizedTitle = this.normalizeSearchText(title);
    const normalizedAuthor = this.normalizeSearchText(author);
    const normalizedCombined = `${normalizedTitle} ${normalizedAuthor}`.trim();
    const compactTitle = this.stripNoiseWords(normalizedTitle);
    const compactCombined = this.stripNoiseWords(normalizedCombined);

    return [...new Set([combined, normalizedCombined, compactCombined, compactTitle, normalizedTitle])]
      .map((candidate) => candidate.trim().slice(0, FALLBACK_QUERY_MAX_LENGTH))
      .filter((candidate) => candidate.length > 2);
  }

  private normalizeSearchText(value: string): string {
    return value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private stripNoiseWords(value: string): string {
    return value
      .split(/\s+/)
      .filter((token) => !SEARCH_QUERY_NOISE_WORDS.has(token.toLowerCase()))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private pickBestFallbackCandidate(
    candidates: Track[],
    failedTrack: QueueTrack,
    avoidYoutubeCandidates: boolean
  ): Track | null {
    const withoutSelf = candidates.filter(
      (candidate) => candidate.info.identifier !== failedTrack.info.identifier
    );
    const filtered = avoidYoutubeCandidates
      ? withoutSelf.filter((candidate) => !this.isYoutubeSource(candidate.info.sourceName))
      : withoutSelf;

    const usable = filtered.length > 0 ? filtered : withoutSelf;
    if (usable.length === 0) {
      return null;
    }

    let bestTrack: Track | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of usable) {
      const score = this.scoreFallbackCandidate(candidate, failedTrack);
      if (score <= bestScore) {
        continue;
      }

      bestScore = score;
      bestTrack = candidate;
    }

    return bestTrack ?? usable[0] ?? null;
  }

  private scoreFallbackCandidate(candidate: Track, failedTrack: QueueTrack): number {
    const failedTitle = this.stripNoiseWords(this.normalizeSearchText(failedTrack.info.title ?? ""));
    const failedAuthor = this.stripNoiseWords(this.normalizeSearchText(failedTrack.info.author ?? ""));
    const candidateTitle = this.stripNoiseWords(this.normalizeSearchText(candidate.info.title ?? ""));
    const candidateAuthor = this.stripNoiseWords(this.normalizeSearchText(candidate.info.author ?? ""));

    const titleScore = this.tokenOverlapRatio(candidateTitle, failedTitle) * 10;
    const authorScore = this.tokenOverlapRatio(candidateAuthor, failedAuthor) * 6;
    const durationScore = this.getDurationSimilarityScore(
      candidate.info.duration,
      failedTrack.info.duration
    );
    const sourceScore = this.isYoutubeSource(candidate.info.sourceName) ? 0 : 2;

    return titleScore + authorScore + durationScore + sourceScore;
  }

  private tokenOverlapRatio(left: string, right: string): number {
    if (!left || !right) {
      return 0;
    }

    const leftTokens = new Set(left.split(/\s+/));
    const rightTokens = new Set(right.split(/\s+/));
    if (leftTokens.size === 0 || rightTokens.size === 0) {
      return 0;
    }

    let sharedCount = 0;
    for (const token of leftTokens) {
      if (!rightTokens.has(token)) {
        continue;
      }

      sharedCount += 1;
    }

    return sharedCount / Math.max(leftTokens.size, rightTokens.size);
  }

  private getDurationSimilarityScore(
    candidateDurationMs: number | undefined,
    failedDurationMs: number | undefined
  ): number {
    if (!candidateDurationMs || !failedDurationMs) {
      return 0;
    }

    const delta = Math.abs(candidateDurationMs - failedDurationMs);
    const ratio = delta / Math.max(candidateDurationMs, failedDurationMs);
    if (ratio <= 0.05) {
      return 3;
    }

    if (ratio <= 0.15) {
      return 2;
    }

    if (ratio <= 0.3) {
      return 1;
    }

    return 0;
  }

  private async resumeAfterFallbackReplacement(
    player: Player,
    failedTrack: QueueTrack
  ): Promise<void> {
    const current = player.queue.current;
    if (
      current &&
      this.isSameTrack(
        current as QueueTrack,
        failedTrack.info.identifier ?? null,
        failedTrack.info.title ?? null,
        failedTrack.info.author ?? null
      )
    ) {
      await player.skip();
      return;
    }

    if (!player.playing && !player.paused) {
      await player.play();
    }
  }

  private isHardYoutubePlaybackFailure(message: string): boolean {
    const normalizedMessage = message.toLowerCase();
    return (
      normalizedMessage.includes("all clients failed") ||
      normalizedMessage.includes("status code: 403") ||
      normalizedMessage.includes("expected decoding to halt") ||
      normalizedMessage.includes("decoding the track") ||
      normalizedMessage.includes("video player configuration error") ||
      normalizedMessage.includes("requires login")
    );
  }

  private isYoutubeSource(sourceName: string | undefined): boolean {
    return sourceName?.toLowerCase().includes("youtube") ?? false;
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

  private async getRequiredPanelContext(interaction: ButtonInteraction): Promise<{
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

  private shouldTryYoutubeFallback(sourceName: string | undefined, message: string): boolean {
    if (!this.isYoutubeSource(sourceName)) {
      return false;
    }

    return (
      this.isHardYoutubePlaybackFailure(message) ||
      message.toLowerCase().includes("must find sig function")
    );
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
