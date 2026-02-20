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

export class MusicService {
  private readonly pendingDestroyTimers = new Map<string, NodeJS.Timeout>();
  private readonly fallbackGuard = new Set<string>();

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

    const result = await player.search(
      resolution.searchQuery as SearchQuery,
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
            message: "Piste skippee. La file est maintenant vide.",
            state: await this.getPanelState(guildId)
          };
        }
        return {
          message: `Piste skippee. En cours: ${displayTrack(nowPlaying)}.`,
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
          off: "off",
          track: "piste",
          queue: "file"
        };
        return {
          message: `Mode boucle: ${labels[nextMode]}.`,
          state: await this.getPanelState(guildId)
        };
      }

      case PANEL_BUTTONS.autoplay: {
        const result = await this.setAutoplay(guildId);
        return {
          message: `Autoplay ${result.enabled ? "active" : "desactive"}.`,
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
    });

    this.lavalink.manager.on("trackError", async (player, track, payload) => {
      try {
        if (!track) {
          return;
        }

        const message = payload.exception?.message ?? "";
        if (!this.shouldTryYoutubeFallback(track.info.sourceName, message)) {
          return;
        }

        const fallbackKey = `${player.guildId}:${track.info.identifier ?? track.info.title ?? "inconnu"}`;
        if (this.fallbackGuard.has(fallbackKey)) {
          return;
        }

        this.fallbackGuard.add(fallbackKey);
        setTimeout(() => this.fallbackGuard.delete(fallbackKey), 15 * 60 * 1000);

        const query = `${track.info.title ?? ""} ${track.info.author ?? ""}`.trim();
        if (!query) {
          return;
        }

        const search = await player.search(
          {
            query,
            source: "scsearch"
          },
          { id: "fallback", username: "FallbackAuto" }
        );
        const replacement = search.tracks[0];
        if (!replacement) {
          return;
        }

        await player.queue.add(replacement as Track, 0);
        if (!player.playing && !player.paused) {
          await player.play();
        }

        this.logger.warn(
          {
            guildId: player.guildId,
            failedTrack: track.info.title,
            replacementTrack: replacement.info.title
          },
          "Fallback SoundCloud ajoute apres echec YouTube"
        );
      } catch (error) {
        this.logger.warn({ err: error, guildId: player.guildId }, "Echec de fallback auto");
      }
    });

    this.lavalink.manager.on("playerDestroy", (player) => {
      this.clearPendingDestroy(player.guildId);
    });

    this.lavalink.manager.on("queueEnd", async (player, lastTrack) => {
      const settings = await this.guildSettings.get(player.guildId);

      if (settings.autoplay && lastTrack) {
        const seed = `${lastTrack.info.title ?? ""} ${lastTrack.info.author ?? ""}`.trim();
        if (seed.length > 0) {
          const search = await player.search(
            {
              query: seed,
              source: "ytmsearch"
            },
            { id: "autoplay", username: "Autoplay" }
          );

          const next =
            search.tracks.find((track) => track.info.identifier !== lastTrack.info.identifier) ??
            search.tracks[0];

          if (next) {
            await player.queue.add(next as Track);
            await player.play();
            this.logger.info({ guildId: player.guildId }, "Autoplay a ajoute une piste");
            return;
          }
        }
      }

      if (settings.stayInVoice) {
        this.logger.info({ guildId: player.guildId }, "Fin de file, connexion vocale conservee");
        return;
      }

      this.scheduleDestroy(player);
    });
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
      void player.destroy("Fin de file et inactivite");
      this.pendingDestroyTimers.delete(player.guildId);
    }, this.emptyDestroyTimeoutMs);

    this.pendingDestroyTimers.set(player.guildId, timer);
    this.logger.info(
      { guildId: player.guildId, timeoutMs: this.emptyDestroyTimeoutMs },
      "Suppression du player planifiee apres fin de file"
    );
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
    if (!sourceName?.toLowerCase().includes("youtube")) {
      return false;
    }

    const normalizedMessage = message.toLowerCase();
    return (
      normalizedMessage.includes("all clients failed") ||
      normalizedMessage.includes("must find sig function") ||
      normalizedMessage.includes("requires login") ||
      normalizedMessage.includes("status code: 403")
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
