import { Events, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { Player } from "lavalink-client";
import type { Logger } from "pino";

import type { QuantumClient } from "../../core/QuantumClient";
import type { PanelState } from "../music/MusicPanel";
import type { MusicPanelDisplay, QueueTrack } from "../music/types";
import type { EnqueueResult } from "../music/types";
import { pickRandomJukeboxNames } from "./jukeboxNames";

const APOCALYPSE_GIF_URL = "https://media.giphy.com/media/l2JdX3hQjFmS8N3fq/giphy.gif";

interface ChannelAssignment {
  key: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  slotId: string;
  callsign: string;
  boundAt: number;
  lastActionAt: number;
}

interface JukeboxSlot {
  id: string;
  callsign: string;
  client: QuantumClient;
}

interface DelegationContext {
  assignment: ChannelAssignment;
  slot: JukeboxSlot;
  slotInteraction: ChatInputCommandInteraction;
}

export class ChannelBoundJukeboxCoordinator {
  private readonly slots: JukeboxSlot[];
  private readonly assignmentsByChannel = new Map<string, ChannelAssignment>();
  private readonly assignmentsBySlot = new Map<string, ChannelAssignment>();

  public constructor(
    private readonly orchestrator: QuantumClient,
    jukeboxClients: QuantumClient[],
    private readonly fixedNames: string[],
    private readonly logger: Logger
  ) {
    const names = pickRandomJukeboxNames(jukeboxClients.length, fixedNames);
    this.slots = jukeboxClients.map((client, index) => ({
      id: `jukebox-${index + 1}`,
      callsign: names[index] ?? `Jukebox ${index + 1}`,
      client
    }));
  }

  public initialize(): void {
    for (const slot of this.slots) {
      this.bindSlotLifecycle(slot);
    }
  }

  public async fetchMember(interaction: ChatInputCommandInteraction): Promise<GuildMember> {
    if (!interaction.guild) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    return interaction.guild.members.fetch(interaction.user.id);
  }

  public async enqueue(
    interaction: ChatInputCommandInteraction,
    input: string
  ): Promise<EnqueueResult> {
    return this.delegateWithFailover(
      interaction,
      { createIfMissing: true },
      (context) => context.slot.client.musicService.enqueue(context.slotInteraction, input)
    );
  }

  public async playCustomPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string,
    shuffle: boolean
  ): Promise<{ addedCount: number; requestedCount: number; duplicateSkippedCount: number }> {
    return this.delegateWithFailover(
      interaction,
      { createIfMissing: true },
      (context) =>
        context.slot.client.musicService.playCustomPlaylist(
          context.slotInteraction,
          playlistName,
          shuffle
        )
    );
  }

  public async skip(interaction: ChatInputCommandInteraction): Promise<QueueTrack | null> {
    return this.delegateWithFailover(
      interaction,
      { createIfMissing: false },
      (context) => context.slot.client.musicService.skip(context.slotInteraction)
    );
  }

  public async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    await this.delegateWithFailover(
      interaction,
      { createIfMissing: false, allowFailover: false },
      async (context) => {
        await context.slot.client.musicService.stop(context.slotInteraction);
      }
    );

    await this.releaseIfSlotDisconnected(interaction);
  }

  public async pause(interaction: ChatInputCommandInteraction): Promise<void> {
    await this.delegateWithFailover(
      interaction,
      { createIfMissing: false },
      async (context) => {
        await context.slot.client.musicService.pause(context.slotInteraction);
      }
    );
  }

  public async resume(interaction: ChatInputCommandInteraction): Promise<void> {
    await this.delegateWithFailover(
      interaction,
      { createIfMissing: false },
      async (context) => {
        await context.slot.client.musicService.resume(context.slotInteraction);
      }
    );
  }

  public async leave(interaction: ChatInputCommandInteraction): Promise<void> {
    await this.delegateWithFailover(
      interaction,
      { createIfMissing: false, allowFailover: false },
      async (context) => {
        await context.slot.client.musicService.leave(context.slotInteraction);
      }
    );

    await this.releaseIfSlotDisconnected(interaction);
  }

  public async setVolume(
    interaction: ChatInputCommandInteraction,
    volume: number
  ): Promise<number> {
    return this.delegateWithFailover(
      interaction,
      { createIfMissing: false },
      (context) => context.slot.client.musicService.setVolume(context.slotInteraction, volume)
    );
  }

  public async setAutoplay(
    guildId: string,
    forcedValue?: boolean
  ): Promise<{ enabled: boolean }> {
    return this.orchestrator.musicService.setAutoplay(guildId, forcedValue);
  }

  public async setStayInVoice(
    guildId: string,
    forcedValue?: boolean
  ): Promise<{ enabled: boolean }> {
    return this.orchestrator.musicService.setStayInVoice(guildId, forcedValue);
  }

  public async applyFilter(
    interaction: ChatInputCommandInteraction,
    effect: "reset" | "nightcore" | "vaporwave" | "bassboost" | "rock"
  ): Promise<void> {
    await this.delegateWithFailover(
      interaction,
      { createIfMissing: false },
      async (context) => {
        await context.slot.client.musicService.applyFilter(context.slotInteraction, effect);
      }
    );
  }

  public async saveCurrentTrackToPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string
  ): Promise<QueueTrack> {
    return this.delegateWithFailover(
      interaction,
      { createIfMissing: false },
      (context) =>
        context.slot.client.musicService.saveCurrentTrackToPlaylist(
          context.slotInteraction,
          playlistName
        )
    );
  }

  public async saveQueueToPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string
  ): Promise<{ addedCount: number; attemptedCount: number }> {
    return this.delegateWithFailover(
      interaction,
      { createIfMissing: false },
      (context) =>
        context.slot.client.musicService.saveQueueToPlaylist(context.slotInteraction, playlistName)
    );
  }

  public async addQueryToPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string,
    query: string
  ): Promise<{ addedCount: number; attemptedCount: number; sourceLabel: string }> {
    const slot = this.findFirstOperationalSlot();
    if (!slot) {
      throw new Error(this.buildNoJukeboxAvailableMessage());
    }

    const slotInteraction = await this.buildSlotInteraction(interaction, slot);
    return slot.client.musicService.addQueryToPlaylist(slotInteraction, playlistName, query);
  }

  public async saveSessionHistoryToPlaylist(
    interaction: ChatInputCommandInteraction,
    playlistName: string,
    maxTracks = 30
  ): Promise<{ addedCount: number; attemptedCount: number; availableCount: number }> {
    return this.delegateWithFailover(
      interaction,
      { createIfMissing: false },
      (context) =>
        context.slot.client.musicService.saveSessionHistoryToPlaylist(
          context.slotInteraction,
          playlistName,
          maxTracks
        )
    );
  }

  public async getQueueSummaryForInteraction(
    interaction: ChatInputCommandInteraction,
    previewCount = 10
  ): Promise<{ current: string | null; upcoming: string[] }> {
    return this.delegateWithFailover(
      interaction,
      { createIfMissing: false, allowFailover: false },
      async (context) =>
        context.slot.client.musicService.getQueueSummary(context.assignment.guildId, previewCount)
    );
  }

  public async getNowPlayingForInteraction(
    interaction: ChatInputCommandInteraction
  ): Promise<string | null> {
    return this.delegateWithFailover(
      interaction,
      { createIfMissing: false, allowFailover: false },
      async (context) => context.slot.client.musicService.getNowPlaying(context.assignment.guildId)
    );
  }

  public getQueueSummary(guildId: string, previewCount = 10): { current: string | null; upcoming: string[] } {
    const assignment = [...this.assignmentsByChannel.values()].find((value) => value.guildId === guildId);
    if (!assignment) {
      return { current: null, upcoming: [] };
    }

    const slot = this.findSlot(assignment.slotId);
    if (!slot) {
      return { current: null, upcoming: [] };
    }

    return slot.client.musicService.getQueueSummary(guildId, previewCount);
  }

  public getNowPlaying(guildId: string): string | null {
    const assignment = [...this.assignmentsByChannel.values()].find((value) => value.guildId === guildId);
    if (!assignment) {
      return null;
    }

    const slot = this.findSlot(assignment.slotId);
    if (!slot) {
      return null;
    }

    return slot.client.musicService.getNowPlaying(guildId);
  }

  public async describeAssignedJukebox(interaction: ChatInputCommandInteraction): Promise<string | null> {
    const voice = await this.resolveRequesterVoice(interaction);
    if (!voice) {
      return null;
    }

    const assignment = this.assignmentsByChannel.get(this.toChannelKey(voice.guildId, voice.voiceChannelId));
    if (!assignment) {
      return null;
    }

    return assignment.callsign;
  }

  public getPanelState(_guildId: string): Promise<PanelState> {
    return Promise.resolve({
      paused: false,
      autoplay: false,
      repeatMode: "off",
      hasPrevious: false
    });
  }

  public getPanelDisplay(_guildId: string): Promise<MusicPanelDisplay | null> {
    return Promise.resolve(null);
  }

  public getPlayer(_guildId: string): Player | undefined {
    return undefined;
  }

  public handlePanelAction(): Promise<{ message: string; state?: PanelState; disablePanel?: boolean }> {
    throw new Error("Le panneau est desactive en mode orchestrateur multi-jukebox.");
  }

  public handlePanelSelectAction(): Promise<{ message: string; state?: PanelState }> {
    throw new Error("Le panneau est desactive en mode orchestrateur multi-jukebox.");
  }

  private async delegateWithFailover<T>(
    interaction: ChatInputCommandInteraction,
    options: { createIfMissing: boolean; allowFailover?: boolean },
    executor: (context: DelegationContext) => Promise<T>
  ): Promise<T> {
    const allowFailover = options.allowFailover ?? true;
    const context = await this.resolveDelegationContext(interaction, options.createIfMissing);

    try {
      return await executor(context);
    } catch (error) {
      if (!allowFailover || !this.isRecoverableError(error)) {
        throw error;
      }

      const fallback = await this.tryFailover(context, interaction);
      if (!fallback) {
        throw error;
      }

      this.logger.warn(
        {
          fromSlot: context.slot.id,
          toSlot: fallback.slot.id,
          guildId: fallback.assignment.guildId,
          voiceChannelId: fallback.assignment.voiceChannelId
        },
        "Failover jukebox applique apres erreur"
      );

      return executor(fallback);
    }
  }

  private async tryFailover(
    context: DelegationContext,
    interaction: ChatInputCommandInteraction
  ): Promise<DelegationContext | null> {
    const replacement = this.findFirstOperationalSlot([context.slot.id]);
    if (!replacement) {
      return null;
    }

    this.releaseByChannelKey(context.assignment.key, "failover");

    const reassigned = this.assignSlot(
      replacement,
      context.assignment.guildId,
      context.assignment.voiceChannelId,
      interaction.channelId
    );
    const slotInteraction = await this.buildSlotInteraction(interaction, replacement);
    return {
      assignment: reassigned,
      slot: replacement,
      slotInteraction
    };
  }

  private async resolveDelegationContext(
    interaction: ChatInputCommandInteraction,
    createIfMissing: boolean
  ): Promise<DelegationContext> {
    const voice = await this.resolveRequesterVoice(interaction);
    if (!voice) {
      throw new Error("Rejoins d'abord un salon vocal.");
    }

    const key = this.toChannelKey(voice.guildId, voice.voiceChannelId);
    const existing = this.assignmentsByChannel.get(key);
    if (existing) {
      const slot = this.findSlot(existing.slotId);
      if (slot && this.isSlotOperational(slot)) {
        existing.lastActionAt = Date.now();
        existing.textChannelId = interaction.channelId;
        const slotInteraction = await this.buildSlotInteraction(interaction, slot);
        return { assignment: existing, slot, slotInteraction };
      }

      this.releaseByChannelKey(key, "slot indisponible");
    }

    if (!createIfMissing) {
      throw new Error(
        "Aucun jukebox n'est affecte a ce salon vocal. Lance d'abord une lecture avec /play."
      );
    }

    const slot = this.findFirstOperationalSlot();
    if (!slot) {
      throw new Error(this.buildNoJukeboxAvailableMessage());
    }

    const assignment = this.assignSlot(slot, voice.guildId, voice.voiceChannelId, interaction.channelId);
    const slotInteraction = await this.buildSlotInteraction(interaction, slot);
    return { assignment, slot, slotInteraction };
  }

  private async resolveRequesterVoice(
    interaction: ChatInputCommandInteraction
  ): Promise<{ guildId: string; voiceChannelId: string } | null> {
    if (!interaction.guildId || !interaction.guild) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const voiceChannelId = member.voice.channelId;
    if (!voiceChannelId) {
      return null;
    }

    return {
      guildId: interaction.guildId,
      voiceChannelId
    };
  }

  private assignSlot(
    slot: JukeboxSlot,
    guildId: string,
    voiceChannelId: string,
    textChannelId: string
  ): ChannelAssignment {
    const key = this.toChannelKey(guildId, voiceChannelId);
    const assignment: ChannelAssignment = {
      key,
      guildId,
      voiceChannelId,
      textChannelId,
      slotId: slot.id,
      callsign: slot.callsign,
      boundAt: Date.now(),
      lastActionAt: Date.now()
    };

    this.assignmentsByChannel.set(key, assignment);
    this.assignmentsBySlot.set(slot.id, assignment);
    this.logger.info(
      { slotId: slot.id, callsign: slot.callsign, guildId, voiceChannelId },
      "Jukebox affecte a un salon vocal"
    );
    return assignment;
  }

  private releaseByChannelKey(channelKey: string, reason: string): void {
    const assignment = this.assignmentsByChannel.get(channelKey);
    if (!assignment) {
      return;
    }

    this.assignmentsByChannel.delete(channelKey);
    this.assignmentsBySlot.delete(assignment.slotId);
    this.logger.info(
      {
        slotId: assignment.slotId,
        callsign: assignment.callsign,
        guildId: assignment.guildId,
        voiceChannelId: assignment.voiceChannelId,
        reason
      },
      "Jukebox libere"
    );
  }

  private releaseBySlot(slotId: string, reason: string): void {
    const assignment = this.assignmentsBySlot.get(slotId);
    if (!assignment) {
      return;
    }

    this.releaseByChannelKey(assignment.key, reason);
  }

  private findSlot(slotId: string): JukeboxSlot | null {
    return this.slots.find((slot) => slot.id === slotId) ?? null;
  }

  private findFirstOperationalSlot(excludedSlotIds: string[] = []): JukeboxSlot | null {
    const excluded = new Set(excludedSlotIds);
    for (const slot of this.slots) {
      if (excluded.has(slot.id)) {
        continue;
      }

      this.cleanStaleAssignment(slot);
      if (this.assignmentsBySlot.has(slot.id)) {
        continue;
      }

      if (!this.isSlotOperational(slot)) {
        continue;
      }

      return slot;
    }

    return null;
  }

  private cleanStaleAssignment(slot: JukeboxSlot): void {
    const assignment = this.assignmentsBySlot.get(slot.id);
    if (!assignment) {
      return;
    }

    const guild = slot.client.guilds.cache.get(assignment.guildId);
    const me = guild?.members.me;
    if (!me?.voice.channelId) {
      this.releaseBySlot(slot.id, "stale assignment cleanup");
    }
  }

  private isSlotOperational(slot: JukeboxSlot): boolean {
    return slot.client.isReady() && slot.client.lavalinkService.manager.useable;
  }

  private async buildSlotInteraction(
    interaction: ChatInputCommandInteraction,
    slot: JukeboxSlot
  ): Promise<ChatInputCommandInteraction> {
    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const slotGuild =
      slot.client.guilds.cache.get(interaction.guildId) ??
      (await slot.client.guilds.fetch(interaction.guildId).catch(() => null));
    if (!slotGuild) {
      throw new Error(`Le jukebox ${slot.callsign} n'est pas present sur ce serveur.`);
    }

    return new Proxy(interaction, {
      get(target, property, receiver) {
        if (property === "guild") {
          return slotGuild;
        }

        return Reflect.get(target, property, receiver);
      }
    }) as ChatInputCommandInteraction;
  }

  private toChannelKey(guildId: string, voiceChannelId: string): string {
    return `${guildId}:${voiceChannelId}`;
  }

  private isRecoverableError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes("lavalink") ||
      message.includes("noeud") ||
      message.includes("econn") ||
      message.includes("socket") ||
      message.includes("disponible")
    );
  }

  private async releaseIfSlotDisconnected(interaction: ChatInputCommandInteraction): Promise<void> {
    const voice = await this.resolveRequesterVoice(interaction).catch(() => null);
    if (!voice) {
      return;
    }

    const key = this.toChannelKey(voice.guildId, voice.voiceChannelId);
    const assignment = this.assignmentsByChannel.get(key);
    if (!assignment) {
      return;
    }

    const slot = this.findSlot(assignment.slotId);
    if (!slot) {
      this.releaseByChannelKey(key, "slot missing after command");
      return;
    }

    const guild = slot.client.guilds.cache.get(assignment.guildId);
    const me = guild?.members.me;
    if (!me?.voice.channelId) {
      this.releaseByChannelKey(key, "jukebox disconnected from voice");
    }
  }

  private bindSlotLifecycle(slot: JukeboxSlot): void {
    slot.client.once(Events.ClientReady, () => {
      void this.applyNickname(slot);
      this.logger.info({ slotId: slot.id, callsign: slot.callsign }, "Jukebox pret");
    });

    slot.client.on(Events.ShardDisconnect, () => {
      this.releaseBySlot(slot.id, "discord shard disconnect");
    });

    slot.client.on(Events.VoiceStateUpdate, (_oldState, newState) => {
      if (newState.id !== slot.client.user?.id) {
        return;
      }

      if (newState.channelId) {
        return;
      }

      this.releaseBySlot(slot.id, "voice state disconnect");
    });

    slot.client.lavalinkService.manager.on("playerDestroy", (player) => {
      const assignment = this.assignmentsBySlot.get(slot.id);
      if (!assignment) {
        return;
      }

      if (assignment.guildId !== player.guildId) {
        return;
      }

      this.releaseBySlot(slot.id, "player destroy");
    });
  }

  private async applyNickname(slot: JukeboxSlot): Promise<void> {
    const guild =
      slot.client.guilds.cache.get(slot.client.config.discordGuildId) ??
      (await slot.client.guilds.fetch(slot.client.config.discordGuildId).catch(() => null));
    if (!guild) {
      return;
    }

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!me) {
      return;
    }

    await me.setNickname(slot.callsign).catch((error) => {
      this.logger.warn(
        { err: error, slotId: slot.id, callsign: slot.callsign },
        "Impossible de definir le pseudo du jukebox"
      );
    });
  }

  private buildNoJukeboxAvailableMessage(): string {
    return [
      "ALERTE GENERALE: tous les jukebox sont deja en mission.",
      "Le systeme approche de l'effondrement thermique. Aucun slot libre pour ce salon vocal.",
      APOCALYPSE_GIF_URL
    ].join("\n");
  }
}
