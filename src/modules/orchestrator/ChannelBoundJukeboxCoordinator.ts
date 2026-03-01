import { Events, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { Player } from "lavalink-client";
import type { Logger } from "pino";

import type { QuantumClient } from "../../core/QuantumClient";
import type { PanelState } from "../music/MusicPanel";
import type {
  ControlSurfaceCoordinator,
  JukeboxSessionSnapshot,
  JukeboxSlotSnapshot
} from "../music/MusicControlSurfaceService";
import type { MusicPanelDisplay, QueueTrack } from "../music/types";
import type { EnqueueResult } from "../music/types";
import { displayTrack } from "../music/trackHelpers";
import { pickRandomJukeboxName, pickRandomJukeboxNames } from "./jukeboxNames";

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

export class ChannelBoundJukeboxCoordinator implements ControlSurfaceCoordinator {
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
    this.bindOrchestratorLifecycle();
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

  public getSlotSnapshots(guildId: string): JukeboxSlotSnapshot[] {
    return this.slots.map((slot) => {
      const assignment = this.assignmentsBySlot.get(slot.id);
      const player = slot.client.musicService.getPlayer(guildId);
      const focusTrack = player?.queue.current ?? player?.queue.tracks[0] ?? null;
      const connectedVoiceChannelId = this.getSlotConnectedVoiceChannelId(slot, guildId);

      if (!this.isSlotOperational(slot)) {
        return {
          slotId: slot.id,
          callsign: slot.callsign,
          mode: "offline",
          voiceChannelId: connectedVoiceChannelId,
          sessionChannelId: connectedVoiceChannelId,
          currentTrack: focusTrack ? displayTrack(focusTrack) : null,
          queueDepth: player ? player.queue.tracks.length : 0
        };
      }

      if (!assignment || assignment.guildId !== guildId) {
        return {
          slotId: slot.id,
          callsign: slot.callsign,
          mode: connectedVoiceChannelId ? "assigned" : "available",
          voiceChannelId: connectedVoiceChannelId,
          sessionChannelId: connectedVoiceChannelId,
          currentTrack: focusTrack ? displayTrack(focusTrack) : null,
          queueDepth: player ? player.queue.tracks.length : 0
        };
      }

      return {
        slotId: slot.id,
        callsign: assignment.callsign,
        mode: player?.paused ? "paused" : player?.playing ? "playing" : "assigned",
        voiceChannelId: assignment.voiceChannelId,
        sessionChannelId: assignment.textChannelId,
        currentTrack: focusTrack ? displayTrack(focusTrack) : null,
        queueDepth: player ? player.queue.tracks.length : 0
      };
    });
  }

  public getSessionSnapshots(guildId: string): JukeboxSessionSnapshot[] {
    const snapshots: JukeboxSessionSnapshot[] = [];

    for (const assignment of this.assignmentsByChannel.values()) {
      if (assignment.guildId !== guildId) {
        continue;
      }

      const slot = this.findSlot(assignment.slotId);
      if (!slot) {
        continue;
      }

      const player = slot.client.musicService.getPlayer(guildId);
      const focusTrack = player?.queue.current ?? player?.queue.tracks[0] ?? null;
      snapshots.push({
        guildId,
        slotId: slot.id,
        callsign: assignment.callsign,
        mode: player?.paused ? "paused" : player?.playing ? "playing" : focusTrack ? "queued" : "idle",
        voiceChannelId: assignment.voiceChannelId,
        sessionChannelId: assignment.textChannelId,
        trackTitle: focusTrack?.info.title ?? null,
        trackAuthor: focusTrack?.info.author ?? null,
        trackUrl: focusTrack?.info.uri ?? null,
        artworkUrl: focusTrack?.info.artworkUrl ?? null,
        sourceLabel: focusTrack?.info.sourceName ?? "unknown",
        durationMs: focusTrack?.info.duration ?? 0,
        positionMs: player?.queue.current ? Math.max(0, player.position) : 0,
        queueDepth: player ? player.queue.tracks.length : 0,
        queuePreview: (player?.queue.tracks ?? [])
          .slice(0, 3)
          .map((track) => displayTrack(track)),
        volume: player?.volume ?? slot.client.config.defaultVolume
      });
    }

    return snapshots;
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
    const replacement = this.findFirstOperationalSlot(
      [context.slot.id],
      context.assignment.guildId,
      context.assignment.voiceChannelId
    );
    if (!replacement) {
      return null;
    }

    this.releaseByChannelKey(context.assignment.key, "failover");

    const reassigned = this.assignSlot(
      replacement,
      context.assignment.guildId,
      context.assignment.voiceChannelId,
      context.assignment.voiceChannelId
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
        const connectedVoiceChannelId = this.getSlotConnectedVoiceChannelId(slot, existing.guildId);
        if (!connectedVoiceChannelId) {
          this.releaseByChannelKey(key, "slot deconnecte detecte pendant delegation");
        } else if (connectedVoiceChannelId !== existing.voiceChannelId) {
          this.rebindAssignmentVoiceChannel(
            existing,
            connectedVoiceChannelId,
            "resync affectation pendant delegation"
          );
        }
      } else {
        this.releaseByChannelKey(key, "slot indisponible");
      }
    }

    const refreshed = this.assignmentsByChannel.get(key);
    if (refreshed) {
      const slot = this.findSlot(refreshed.slotId);
      if (slot && this.isSlotOperational(slot)) {
        refreshed.lastActionAt = Date.now();
        refreshed.textChannelId = refreshed.voiceChannelId;
        const slotInteraction = await this.buildSlotInteraction(interaction, slot);
        return { assignment: refreshed, slot, slotInteraction };
      }
      this.releaseByChannelKey(key, "slot indisponible apres resync");
    }

    if (!createIfMissing) {
      throw new Error(
        "Aucun jukebox n'est affecte a ce salon vocal. Lance d'abord une lecture avec /play."
      );
    }

    const slot = this.findFirstOperationalSlot([], voice.guildId, voice.voiceChannelId);
    if (!slot) {
      throw new Error(this.buildNoJukeboxAvailableMessage());
    }

    const assignment = this.assignSlot(slot, voice.guildId, voice.voiceChannelId, voice.voiceChannelId);
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
    const callsign = this.rotateSlotCallsign(slot);
    const key = this.toChannelKey(guildId, voiceChannelId);
    const assignment: ChannelAssignment = {
      key,
      guildId,
      voiceChannelId,
      textChannelId,
      slotId: slot.id,
      callsign,
      boundAt: Date.now(),
      lastActionAt: Date.now()
    };

    this.assignmentsByChannel.set(key, assignment);
    this.assignmentsBySlot.set(slot.id, assignment);
    this.logger.info(
      { slotId: slot.id, callsign, guildId, voiceChannelId },
      "Jukebox affecte a un salon vocal"
    );
    void this.applyNickname(slot);
    void this.orchestrator.refreshRegisteredMusicPanel(guildId, `Routing actif: ${callsign}.`);
    return assignment;
  }

  private rotateSlotCallsign(slot: JukeboxSlot): string {
    const activeCallsigns: string[] = [];
    for (const assignment of this.assignmentsByChannel.values()) {
      activeCallsigns.push(assignment.callsign);
    }

    activeCallsigns.push(slot.callsign);
    const callsign = pickRandomJukeboxName(this.fixedNames, activeCallsigns);
    slot.callsign = callsign;
    return callsign;
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
    void this.orchestrator.refreshRegisteredMusicPanel(assignment.guildId, "Session terminee.");
  }

  private releaseBySlot(slotId: string, reason: string): void {
    const assignment = this.assignmentsBySlot.get(slotId);
    if (!assignment) {
      return;
    }

    this.releaseByChannelKey(assignment.key, reason);
  }

  private rebindAssignmentVoiceChannel(
    assignment: ChannelAssignment,
    newVoiceChannelId: string,
    reason: string
  ): void {
    if (assignment.voiceChannelId === newVoiceChannelId) {
      return;
    }

    const previousVoiceChannelId = assignment.voiceChannelId;
    const previousKey = assignment.key;
    const nextKey = this.toChannelKey(assignment.guildId, newVoiceChannelId);

    const conflict = this.assignmentsByChannel.get(nextKey);
    if (conflict && conflict.slotId !== assignment.slotId) {
      this.releaseByChannelKey(nextKey, `${reason}: collision takeover`);
    }

    this.assignmentsByChannel.delete(previousKey);
    assignment.voiceChannelId = newVoiceChannelId;
    assignment.key = nextKey;
    assignment.textChannelId = newVoiceChannelId;
    assignment.boundAt = Date.now();
    assignment.lastActionAt = Date.now();
    this.assignmentsByChannel.set(nextKey, assignment);
    this.assignmentsBySlot.set(assignment.slotId, assignment);

    this.logger.info(
      {
        slotId: assignment.slotId,
        callsign: assignment.callsign,
        guildId: assignment.guildId,
        fromVoiceChannelId: previousVoiceChannelId,
        toVoiceChannelId: newVoiceChannelId,
        reason
      },
      "Jukebox reaffecte suite a changement vocal"
    );
    void this.orchestrator.refreshRegisteredMusicPanel(assignment.guildId, "Session re-routee.");
  }

  private findSlot(slotId: string): JukeboxSlot | null {
    return this.slots.find((slot) => slot.id === slotId) ?? null;
  }

  private findFirstOperationalSlot(
    excludedSlotIds: string[] = [],
    guildId?: string,
    requestedVoiceChannelId?: string
  ): JukeboxSlot | null {
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

      const connectedVoiceChannelId = this.getSlotConnectedVoiceChannelId(slot, guildId);
      if (connectedVoiceChannelId) {
        if (requestedVoiceChannelId && connectedVoiceChannelId === requestedVoiceChannelId) {
          this.logger.info(
            { slotId: slot.id, callsign: slot.callsign, guildId, connectedVoiceChannelId },
            "Slot recupere: jukebox deja present dans le salon vocal cible"
          );
          return slot;
        }

        this.logger.warn(
          { slotId: slot.id, callsign: slot.callsign, guildId, connectedVoiceChannelId },
          "Slot ignore: jukebox deja connecte a un autre salon vocal"
        );
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
    const connectedVoiceChannelId = me?.voice.channelId;
    if (!connectedVoiceChannelId) {
      this.releaseBySlot(slot.id, "stale assignment cleanup");
      return;
    }

    if (connectedVoiceChannelId !== assignment.voiceChannelId) {
      this.rebindAssignmentVoiceChannel(
        assignment,
        connectedVoiceChannelId,
        "stale assignment move sync"
      );
    }
  }

  private isSlotOperational(slot: JukeboxSlot): boolean {
    return slot.client.isReady() && slot.client.lavalinkService.manager.useable;
  }

  private getSlotConnectedVoiceChannelId(slot: JukeboxSlot, guildId?: string): string | null {
    const targetGuildId = guildId ?? slot.client.config.discordGuildId;
    const guild = slot.client.guilds.cache.get(targetGuildId);
    const me = guild?.members.me;
    return me?.voice.channelId ?? null;
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
      message.includes("deja actif dans un autre salon vocal") ||
      message.includes("meme salon vocal que le bot") ||
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
    const connectedVoiceChannelId = me?.voice.channelId;
    if (!connectedVoiceChannelId) {
      this.releaseByChannelKey(key, "jukebox disconnected from voice");
      return;
    }

    if (connectedVoiceChannelId !== assignment.voiceChannelId) {
      this.rebindAssignmentVoiceChannel(
        assignment,
        connectedVoiceChannelId,
        "post-command move sync"
      );
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

    slot.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      if (newState.id !== slot.client.user?.id) {
        return;
      }

      if (oldState.channelId === newState.channelId) {
        return;
      }

      if (!newState.channelId) {
        this.releaseBySlot(slot.id, "voice state disconnect");
        return;
      }

      const assignment = this.assignmentsBySlot.get(slot.id);
      if (!assignment) {
        this.logger.info(
          {
            slotId: slot.id,
            callsign: slot.callsign,
            guildId: newState.guild.id,
            movedToVoiceChannelId: newState.channelId
          },
          "Jukebox deplace sans affectation active"
        );
        return;
      }

      this.rebindAssignmentVoiceChannel(
        assignment,
        newState.channelId,
        "voice state move"
      );
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

    slot.client.lavalinkService.manager.on("trackStart", (player) => {
      void this.orchestrator.refreshRegisteredMusicPanel(
        player.guildId,
        `${slot.callsign} en lecture.`
      );
    });

    slot.client.lavalinkService.manager.on("queueEnd", (player) => {
      void this.orchestrator.refreshRegisteredMusicPanel(
        player.guildId,
        `${slot.callsign} en attente.`
      );
    });
  }

  private bindOrchestratorLifecycle(): void {
    this.orchestrator.once(Events.ClientReady, () => {
      for (const slot of this.slots) {
        void this.applyNickname(slot);
      }
    });
  }

  private async applyNickname(slot: JukeboxSlot): Promise<void> {
    if (!this.orchestrator.isReady()) {
      return;
    }

    const guild =
      this.orchestrator.guilds.cache.get(this.orchestrator.config.discordGuildId) ??
      (await this.orchestrator.guilds.fetch(this.orchestrator.config.discordGuildId).catch(() => null));
    if (!guild) {
      return;
    }

    const slotUserId = slot.client.user?.id;
    if (!slotUserId) {
      return;
    }

    const slotMember = guild.members.cache.get(slotUserId) ?? (await guild.members.fetch(slotUserId).catch(() => null));
    if (!slotMember) {
      return;
    }

    if (slotMember.nickname === slot.callsign) {
      return;
    }

    try {
      await slotMember.setNickname(slot.callsign);
      return;
    } catch (error) {
      if (this.isMissingPermissionsError(error)) {
        const fallbackApplied = await this.applyNicknameViaSlotSelf(slot);
        if (fallbackApplied) {
          this.logger.info(
            { slotId: slot.id, callsign: slot.callsign },
            "Pseudo du jukebox defini via fallback self-update"
          );
          return;
        }
      }

      this.logger.warn(
        { err: error, slotId: slot.id, callsign: slot.callsign },
        "Impossible de definir le pseudo du jukebox via l'orchestrateur"
      );
    }
  }

  private async applyNicknameViaSlotSelf(slot: JukeboxSlot): Promise<boolean> {
    if (!slot.client.isReady()) {
      return false;
    }

    const guild =
      slot.client.guilds.cache.get(slot.client.config.discordGuildId) ??
      (await slot.client.guilds.fetch(slot.client.config.discordGuildId).catch(() => null));
    if (!guild) {
      return false;
    }

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!me) {
      return false;
    }

    if (me.nickname === slot.callsign) {
      return true;
    }

    try {
      await me.setNickname(slot.callsign);
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, slotId: slot.id, callsign: slot.callsign },
        "Impossible de definir le pseudo du jukebox via self-update"
      );
      return false;
    }
  }

  private isMissingPermissionsError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const maybeCode = (error as { code?: unknown }).code;
    return maybeCode === 50013;
  }

  private buildNoJukeboxAvailableMessage(): string {
    return [
      "ALERTE GENERALE: tous les jukebox sont deja en mission.",
      "Le systeme approche de l'effondrement thermique. Aucun slot libre pour ce salon vocal.",
      APOCALYPSE_GIF_URL
    ].join("\n");
  }
}
