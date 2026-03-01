import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type GuildTextBasedChannel
} from "discord.js";
import type { Logger } from "pino";

import type { AppConfig } from "../../config/env";
import type { AccessPolicyService } from "../policies/AccessPolicyService";
import type { MusicService } from "./MusicService";
import { displayTrack, formatDuration } from "./trackHelpers";

const COMMAND_CENTER_PREFIX = "command_center";
const CLEANUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const SESSION_AUTO_REMOVE_DELAY_MS = 90 * 1000;
const COMMAND_CENTER_COLOR = 0x19c2ff;
const SESSION_LIVE_COLOR = 0x2dd4bf;
const SESSION_IDLE_COLOR = 0xf59e0b;

export const COMMAND_CENTER_BUTTONS = {
  refresh: `${COMMAND_CENTER_PREFIX}:refresh`,
  rebuild: `${COMMAND_CENTER_PREFIX}:rebuild`,
  clean: `${COMMAND_CENTER_PREFIX}:clean`
} as const;

export interface JukeboxSlotSnapshot {
  slotId: string;
  callsign: string;
  mode: "offline" | "available" | "assigned" | "playing" | "paused";
  voiceChannelId: string | null;
  sessionChannelId: string | null;
  currentTrack: string | null;
  queueDepth: number;
}

export interface JukeboxSessionSnapshot {
  guildId: string;
  slotId: string;
  callsign: string;
  mode: "playing" | "paused" | "queued" | "idle";
  voiceChannelId: string;
  sessionChannelId: string;
  trackTitle: string | null;
  trackAuthor: string | null;
  trackUrl: string | null;
  artworkUrl: string | null;
  sourceLabel: string;
  durationMs: number;
  positionMs: number;
  queueDepth: number;
  queuePreview: string[];
  volume: number;
}

export interface ControlSurfaceCoordinator {
  getSlotSnapshots(guildId: string): JukeboxSlotSnapshot[];
  getSessionSnapshots(guildId: string): JukeboxSessionSnapshot[];
}

interface SurfaceHost {
  config: AppConfig;
  logger: Logger;
  accessPolicy: AccessPolicyService;
  musicService: MusicService;
  channels: {
    fetch(id: string): Promise<unknown>;
  };
  guilds: {
    cache: Map<string, Guild>;
    fetch(id: string): Promise<Guild>;
  };
}

interface MessageRef {
  channelId: string;
  messageId: string;
}

interface SessionPanelRef extends MessageRef {
  deleteTimer: NodeJS.Timeout | null;
}

type ManagedMessage = {
  id: string;
  channelId: string;
  edit(payload: unknown): Promise<unknown>;
  delete(): Promise<unknown>;
};

export class MusicControlSurfaceService {
  private readonly commandCenterMessages = new Map<string, MessageRef>();
  private readonly sessionPanels = new Map<string, SessionPanelRef>();
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();
  private readonly nextCleanupAt = new Map<string, number>();
  private readonly guildSurfacePipelines = new Map<string, Promise<unknown>>();
  private coordinator: ControlSurfaceCoordinator | null = null;

  public constructor(
    private readonly host: SurfaceHost,
    private readonly logger: Logger
  ) {}

  public attachCoordinator(coordinator: ControlSurfaceCoordinator): void {
    this.coordinator = coordinator;
  }

  public async initializeForGuild(guildId: string): Promise<void> {
    if (!this.host.config.musicControlChannelId) {
      return;
    }

    await this.cleanCommandCenterChannel(guildId);
    await this.refreshGuild(guildId, "Command center online.", { forceRebuild: true });
    this.scheduleCleanup(guildId);
  }

  public async refreshGuild(
    guildId: string,
    status?: string,
    options: { forceRebuild?: boolean } = {}
  ): Promise<boolean> {
    return this.runGuildSurfaceTask(guildId, async () => {
      let updated = false;

      if (this.host.config.musicControlChannelId) {
        const message = await this.ensureCommandCenterMessage(guildId, options.forceRebuild === true);
        if (message) {
          await message.edit(this.buildCommandCenterPayload(guildId, status));
          updated = true;
        }
      }

      const sessionSnapshots = this.getSessionSnapshots(guildId);
      const activeKeys = new Set<string>();

      for (const snapshot of sessionSnapshots) {
        const key = this.toSessionKey(guildId, snapshot.slotId);
        if (!this.shouldRenderSessionPanel(snapshot)) {
          await this.scheduleSessionRemoval(key, "Session terminee.");
          continue;
        }

        activeKeys.add(key);
        await this.upsertSessionPanel(snapshot, status);
        updated = true;
      }

      const keysToClose = [...this.sessionPanels.keys()].filter(
        (key) => key.startsWith(`${guildId}:`) && !activeKeys.has(key)
      );
      for (const key of keysToClose) {
        await this.scheduleSessionRemoval(key, "Session terminee.");
      }

      return updated;
    });
  }

  public async forceRebuild(guildId: string): Promise<boolean> {
    this.commandCenterMessages.delete(guildId);
    return this.refreshGuild(guildId, "Command center reconstruit.", { forceRebuild: true });
  }

  public async cleanNow(guildId: string): Promise<boolean> {
    await this.cleanCommandCenterChannel(guildId);
    this.commandCenterMessages.delete(guildId);
    this.scheduleCleanup(guildId);
    return this.refreshGuild(guildId, "Canal recycle.", { forceRebuild: true });
  }

  public async handleButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
    if (!Object.values(COMMAND_CENTER_BUTTONS).includes(interaction.customId as never)) {
      return false;
    }

    if (!interaction.guild) {
      await interaction.reply({
        content: "Cette action ne fonctionne que sur un serveur.",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!this.host.accessPolicy.canManageCommandCenter(member)) {
      await interaction.reply({
        content: "Acces refuse: role command center requis.",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: "Impossible de determiner le serveur cible.",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    await interaction.deferUpdate();

    switch (interaction.customId) {
      case COMMAND_CENTER_BUTTONS.refresh:
        await this.refreshGuild(guildId, "Refresh manuel.");
        await interaction.followUp({
          content: "Command center synchronise.",
          flags: MessageFlags.Ephemeral
        });
        return true;
      case COMMAND_CENTER_BUTTONS.rebuild:
        await this.forceRebuild(guildId);
        await interaction.followUp({
          content: "Command center reconstruit.",
          flags: MessageFlags.Ephemeral
        });
        return true;
      case COMMAND_CENTER_BUTTONS.clean:
        await this.cleanNow(guildId);
        await interaction.followUp({
          content: "Canal musique nettoye.",
          flags: MessageFlags.Ephemeral
        });
        return true;
      default:
        return false;
    }
  }

  private async ensureCommandCenterMessage(
    guildId: string,
    forceRebuild: boolean
  ): Promise<ManagedMessage | null> {
    const channelId = this.host.config.musicControlChannelId;
    if (!channelId) {
      return null;
    }

    const channel = await this.fetchGuildTextChannel(channelId);
    if (!channel) {
      this.logger.warn({ channelId }, "Canal du command center introuvable ou inutilisable");
      return null;
    }

    if (!forceRebuild) {
      const existing = this.commandCenterMessages.get(guildId);
      if (existing && existing.channelId === channel.id) {
        const resolved = await this.fetchMessage(channel, existing.messageId);
        if (resolved) {
          return resolved;
        }
      }
    }

    const message = await channel.send(this.buildCommandCenterPayload(guildId, "Boot sync."));
    const managed = this.asManagedMessage(message);
    this.commandCenterMessages.set(guildId, { channelId: channel.id, messageId: managed.id });
    return managed;
  }

  private async upsertSessionPanel(
    snapshot: JukeboxSessionSnapshot,
    status?: string
  ): Promise<void> {
    const key = this.toSessionKey(snapshot.guildId, snapshot.slotId);
    const channel = await this.fetchGuildTextChannel(snapshot.sessionChannelId);
    if (!channel) {
      await this.scheduleSessionRemoval(key, "Salon vocal indisponible.");
      return;
    }

    const existing = this.sessionPanels.get(key);
    if (existing && existing.channelId !== channel.id) {
      await this.scheduleSessionRemoval(key, "Session deplacee.");
    }

    let message: ManagedMessage | null = null;
    if (existing && existing.channelId === channel.id) {
      message = await this.fetchMessage(channel, existing.messageId);
    }

    if (!message) {
      const created = await channel.send(this.buildSessionPayload(snapshot, status));
      const managed = this.asManagedMessage(created);
      this.cancelSessionDeletion(key);
      this.sessionPanels.set(key, {
        channelId: channel.id,
        messageId: managed.id,
        deleteTimer: null
      });
      return;
    }

    this.cancelSessionDeletion(key);
    await message.edit(this.buildSessionPayload(snapshot, status));
  }

  private async scheduleSessionRemoval(key: string, reason: string): Promise<void> {
    const existing = this.sessionPanels.get(key);
    if (!existing) {
      return;
    }

    this.cancelSessionDeletion(key);

    const channel = await this.fetchGuildTextChannel(existing.channelId);
    const message = channel ? await this.fetchMessage(channel, existing.messageId) : null;
    if (message) {
      await message.edit(this.buildSessionClosedPayload(reason));
    }

    const deleteTimer = setTimeout(() => {
      void this.deleteSessionMessage(key);
    }, SESSION_AUTO_REMOVE_DELAY_MS);
    deleteTimer.unref?.();

    this.sessionPanels.set(key, {
      ...existing,
      deleteTimer
    });
  }

  private cancelSessionDeletion(key: string): void {
    const existing = this.sessionPanels.get(key);
    if (!existing?.deleteTimer) {
      return;
    }

    clearTimeout(existing.deleteTimer);
    this.sessionPanels.set(key, {
      ...existing,
      deleteTimer: null
    });
  }

  private async deleteSessionMessage(key: string): Promise<void> {
    const existing = this.sessionPanels.get(key);
    if (!existing) {
      return;
    }

    const channel = await this.fetchGuildTextChannel(existing.channelId);
    const message = channel ? await this.fetchMessage(channel, existing.messageId) : null;
    if (message) {
      await message.delete().catch(() => null);
    }

    this.sessionPanels.delete(key);
  }

  private async cleanCommandCenterChannel(guildId: string): Promise<void> {
    const channelId = this.host.config.musicControlChannelId;
    if (!channelId) {
      return;
    }

    const channel = await this.fetchGuildTextChannel(channelId);
    if (!channel) {
      return;
    }

    while (true) {
      const batch = await channel.messages.fetch({ limit: 100 });
      if (batch.size === 0) {
        break;
      }

      await Promise.allSettled(
        batch.map((message) => message.delete().catch(() => null))
      );

      if (batch.size < 100) {
        break;
      }
    }

    this.commandCenterMessages.delete(guildId);
  }

  private scheduleCleanup(guildId: string): void {
    const previous = this.cleanupTimers.get(guildId);
    if (previous) {
      clearTimeout(previous);
    }

    const dueAt = Date.now() + CLEANUP_WINDOW_MS;
    this.nextCleanupAt.set(guildId, dueAt);

    const timer = setTimeout(() => {
      void this.cleanNow(guildId).catch((error) => {
        this.logger.warn({ err: error, guildId }, "Echec du cleanup automatique du command center");
        this.scheduleCleanup(guildId);
      });
    }, CLEANUP_WINDOW_MS);
    timer.unref?.();
    this.cleanupTimers.set(guildId, timer);
  }

  private buildCommandCenterPayload(guildId: string, status?: string) {
    const slotSnapshots = this.getSlotSnapshots(guildId);
    const sessionSnapshots = this.getSessionSnapshots(guildId).filter((snapshot) =>
      this.shouldRenderSessionPanel(snapshot)
    );
    const onlineCount = slotSnapshots.filter((slot) => slot.mode !== "offline").length;
    const footerStatus = status?.trim().length ? status.trim() : "En ligne";
    const spotlight = sessionSnapshots[0] ?? null;

    const heroEmbed = new EmbedBuilder()
      .setColor(this.resolveAccentColor(spotlight?.sourceLabel, false))
      .setTitle("🎛️ Quantum Music Center")
      .setDescription(
        this.joinSpaced([
          "✨ Hub musique central, propre et visuel.",
          "➕ Ajoute une musique avec `/play query:<url|texte>`.",
          "🗨️ Les sessions apparaissent automatiquement dans le chat du salon vocal."
        ])
      )
      .addFields(
        {
          name: "🛰️ Systeme",
          value: this.joinSpaced([
            `• Mode: ${this.coordinator ? "Multi-jukebox" : "Solo"}`,
            `• Bots actifs: ${onlineCount}/${Math.max(slotSnapshots.length, 1)}`,
            `• Sessions live: ${sessionSnapshots.length}`,
            `• Prochain clean: ${this.formatRemainingCleanup(guildId)}`
          ]),
          inline: true
        },
        {
          name: "✨ En ce moment",
          value: spotlight
            ? this.joinSpaced([
                `• ${this.truncate(spotlight.trackTitle ?? "En attente", 70)}`,
                `• ${spotlight.callsign} dans <#${spotlight.voiceChannelId}>`,
                `• ${spotlight.sourceLabel}`
              ])
            : "Aucune lecture en cours.",
          inline: true
        }
      )
      .setFooter({ text: `✨ Quantum live • ${footerStatus}` })
      .setTimestamp(new Date());

    if (spotlight?.artworkUrl) {
      heroEmbed.setImage(spotlight.artworkUrl);
    }

    if (spotlight?.trackUrl) {
      heroEmbed.setURL(spotlight.trackUrl);
    }

    const fleetEmbed = new EmbedBuilder()
      .setColor(COMMAND_CENTER_COLOR)
      .setTitle("🤖 Parc Jukebox")
      .setDescription(
        slotSnapshots.length === 0
          ? "Aucun jukebox detecte."
          : slotSnapshots
              .map((slot) =>
                this.joinSpaced([
                  `${this.getSlotEmoji(slot.mode)} **${slot.callsign}**`,
                  `Etat: ${this.formatSlotMode(slot.mode)}`,
                  `Vocal: ${slot.voiceChannelId ? `<#${slot.voiceChannelId}>` : "Libre"}`,
                  `File: ${slot.queueDepth}`,
                  `En cours: ${slot.currentTrack ? this.truncate(slot.currentTrack, 90) : "Aucune piste"}`
                ])
              )
              .join("\n\n")
      );

    const sessionsEmbed = new EmbedBuilder()
      .setColor(this.resolveAccentColor(spotlight?.sourceLabel, false))
      .setTitle("📡 Sessions Live")
      .setDescription(
        sessionSnapshots.length === 0
          ? "Aucune session active pour le moment."
          : sessionSnapshots
              .slice(0, 5)
              .map((session) =>
                this.joinSpaced([
                  `${this.getSessionEmoji(session.mode)} **${session.callsign}**`,
                  `Salon: <#${session.voiceChannelId}>`,
                  `Titre: ${this.truncate(session.trackTitle ?? "En attente", 90)}`
                ])
              )
              .join("\n\n")
      );

    if (spotlight?.artworkUrl) {
      sessionsEmbed.setThumbnail(spotlight.artworkUrl);
    }

    return {
      embeds: [heroEmbed, fleetEmbed, sessionsEmbed],
      components: [this.buildCommandCenterActions()]
    };
  }

  private buildSessionPayload(snapshot: JukeboxSessionSnapshot, status?: string) {
    const progress = this.buildProgressBar(snapshot.positionMs, snapshot.durationMs, 12);
    const sourceEmoji = this.getSourceEmoji(snapshot.sourceLabel);
    const title = snapshot.trackTitle
      ? this.truncate(snapshot.trackTitle, 120)
      : "En attente de lecture";
    const queueBlock =
      snapshot.queuePreview.length > 0
        ? snapshot.queuePreview
            .slice(0, 3)
            .map((line, index) => `${index + 1}. ${this.truncate(line, 60)}`)
            .join("\n\n")
        : "Aucune piste suivante";
    const mainEmbed = new EmbedBuilder()
      .setColor(this.resolveAccentColor(snapshot.sourceLabel, snapshot.mode === "paused"))
      .setTitle(`${this.getSessionEmoji(snapshot.mode)} ${snapshot.callsign}`)
      .setDescription(
        this.joinSpaced([
          `**${title}**`,
          `${sourceEmoji} ${snapshot.sourceLabel} • 🎙️ ${this.truncate(snapshot.trackAuthor ?? "Auteur inconnu", 60)}`,
          `🔊 <#${snapshot.voiceChannelId}> • ${this.formatSessionMode(snapshot.mode)}`
        ])
      )
      .addFields(
        {
          name: "⏱️ Lecture",
          value: this.joinSpaced([
            `• Temps: ${formatDuration(snapshot.positionMs)} / ${formatDuration(snapshot.durationMs)}`,
            `• Barre: ${progress}`,
            `• Volume: ${snapshot.volume}%`
          ]),
          inline: true
        },
        {
          name: "🎚️ Session",
          value: this.joinSpaced([
            `• En attente: ${snapshot.queueDepth}`,
            `• Source: ${snapshot.sourceLabel}`,
            `• Etat: ${this.formatSessionMode(snapshot.mode)}`
          ]),
          inline: true
        }
      )
      .setFooter({
        text: status?.trim().length ? `✨ ${status.trim()}` : "✨ Mise a jour live"
      })
      .setTimestamp(new Date());

    if (snapshot.trackUrl) {
      mainEmbed.setURL(snapshot.trackUrl);
    }

    if (snapshot.artworkUrl) {
      mainEmbed.setImage(snapshot.artworkUrl);
    }

    const queueEmbed = new EmbedBuilder()
      .setColor(this.resolveAccentColor(snapshot.sourceLabel, snapshot.mode === "paused"))
      .setTitle("📚 File d'attente")
      .setDescription(queueBlock);

    if (snapshot.artworkUrl) {
      queueEmbed.setThumbnail(snapshot.artworkUrl);
    }

    return {
      embeds: [mainEmbed, queueEmbed]
    };
  }

  private buildSessionClosedPayload(reason: string) {
    const embed = new EmbedBuilder()
      .setColor(SESSION_IDLE_COLOR)
      .setTitle("🌙 Session terminee")
      .setDescription(`${reason}\nLe message disparait automatiquement dans quelques instants.`)
      .setTimestamp(new Date());

    return {
      embeds: [embed]
    };
  }

  private buildCommandCenterActions(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(COMMAND_CENTER_BUTTONS.refresh)
        .setLabel("🔄 Sync")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(COMMAND_CENTER_BUTTONS.rebuild)
        .setLabel("🧱 Refaire")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(COMMAND_CENTER_BUTTONS.clean)
        .setLabel("🧼 Nettoyer")
        .setStyle(ButtonStyle.Danger)
    );
  }

  private getSlotSnapshots(guildId: string): JukeboxSlotSnapshot[] {
    if (this.coordinator) {
      return this.coordinator.getSlotSnapshots(guildId);
    }

    const player = this.host.musicService.getPlayer(guildId);
    const guild = this.getGuild(guildId);
    const voiceChannelId = guild?.members.me?.voice.channelId ?? null;
    const currentTrack = player?.queue.current ?? player?.queue.tracks[0];
    const queueDepth = player ? player.queue.tracks.length : 0;

    return [
      {
        slotId: "primary",
        callsign: "Primary",
        mode: player?.paused
          ? "paused"
          : player?.playing
            ? "playing"
            : voiceChannelId
              ? "assigned"
              : "available",
        voiceChannelId,
        sessionChannelId: voiceChannelId,
        currentTrack: currentTrack ? displayTrack(currentTrack) : null,
        queueDepth
      }
    ];
  }

  private getSessionSnapshots(guildId: string): JukeboxSessionSnapshot[] {
    if (this.coordinator) {
      return this.coordinator.getSessionSnapshots(guildId);
    }

    const guild = this.getGuild(guildId);
    const voiceChannelId = guild?.members.me?.voice.channelId;
    if (!voiceChannelId) {
      return [];
    }

    const player = this.host.musicService.getPlayer(guildId);
    const focusTrack = player?.queue.current ?? player?.queue.tracks[0];

    return [
      {
        guildId,
        slotId: "primary",
        callsign: "Primary",
        mode: player?.paused ? "paused" : player?.playing ? "playing" : focusTrack ? "queued" : "idle",
        voiceChannelId,
        sessionChannelId: voiceChannelId,
        trackTitle: focusTrack?.info.title ?? null,
        trackAuthor: focusTrack?.info.author ?? null,
        trackUrl: focusTrack?.info.uri ?? null,
        artworkUrl: focusTrack?.info.artworkUrl ?? null,
        sourceLabel: this.formatSourceLabel(focusTrack?.info.sourceName),
        durationMs: focusTrack?.info.duration ?? 0,
        positionMs: player?.queue.current ? Math.max(0, player.position) : 0,
        queueDepth: player ? player.queue.tracks.length : 0,
        queuePreview: (player?.queue.tracks ?? []).slice(0, 3).map((track) => displayTrack(track)),
        volume: player?.volume ?? this.host.config.defaultVolume
      }
    ];
  }

  private shouldRenderSessionPanel(snapshot: JukeboxSessionSnapshot): boolean {
    return (
      snapshot.mode === "playing" ||
      snapshot.mode === "paused" ||
      snapshot.mode === "queued"
    );
  }

  private formatSlotMode(mode: JukeboxSlotSnapshot["mode"]): string {
    switch (mode) {
      case "playing":
        return "En lecture";
      case "paused":
        return "En pause";
      case "assigned":
        return "Assigne";
      case "offline":
        return "Hors ligne";
      default:
        return "Libre";
    }
  }

  private formatSessionMode(mode: JukeboxSessionSnapshot["mode"]): string {
    switch (mode) {
      case "playing":
        return "En lecture";
      case "paused":
        return "En pause";
      case "queued":
        return "En attente";
      default:
        return "Idle";
    }
  }

  private formatSourceLabel(value: string | undefined): string {
    const source = value?.trim().toLowerCase() ?? "";
    if (source.includes("spotify")) {
      return "Spotify";
    }

    if (source.includes("youtube")) {
      return "YouTube";
    }

    return value?.trim().length ? value.trim() : "Unknown";
  }

  private formatRemainingCleanup(guildId: string): string {
    const dueAt = this.nextCleanupAt.get(guildId);
    if (!dueAt) {
      return "n/a";
    }

    return `<t:${Math.floor(dueAt / 1000)}:R>`;
  }

  private buildProgressBar(positionMs: number, durationMs: number, size: number): string {
    if (durationMs <= 0) {
      return "▱".repeat(size);
    }

    const ratio = Math.max(0, Math.min(1, positionMs / Math.max(durationMs, 1)));
    const cursor = Math.min(size - 1, Math.max(0, Math.round(ratio * (size - 1))));
    let output = "";

    for (let index = 0; index < size; index += 1) {
      output += index <= cursor ? "▰" : "▱";
    }

    return output;
  }

  private resolveAccentColor(sourceLabel?: string | null, isPaused = false): number {
    if (isPaused) {
      return SESSION_IDLE_COLOR;
    }

    const source = sourceLabel?.trim().toLowerCase() ?? "";
    if (source.includes("spotify")) {
      return 0x1ed760;
    }

    if (source.includes("youtube")) {
      return 0xff4d6d;
    }

    return SESSION_LIVE_COLOR;
  }

  private getSlotEmoji(mode: JukeboxSlotSnapshot["mode"]): string {
    switch (mode) {
      case "playing":
        return "🟢";
      case "paused":
        return "🟠";
      case "assigned":
        return "🟡";
      case "offline":
        return "⚫";
      default:
        return "🔵";
    }
  }

  private getSessionEmoji(mode: JukeboxSessionSnapshot["mode"]): string {
    switch (mode) {
      case "playing":
        return "🎵";
      case "paused":
        return "⏸️";
      case "queued":
        return "🕒";
      default:
        return "🌙";
    }
  }

  private getSourceEmoji(sourceLabel: string): string {
    const source = sourceLabel.trim().toLowerCase();
    if (source.includes("spotify")) {
      return "🟢";
    }

    if (source.includes("youtube")) {
      return "🔴";
    }

    return "🎶";
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  private joinSpaced(lines: string[]): string {
    return lines.filter((line) => line.trim().length > 0).join("\n\n");
  }

  private async runGuildSurfaceTask<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.guildSurfacePipelines.get(guildId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.guildSurfacePipelines.set(guildId, run);

    try {
      return await run;
    } finally {
      if (this.guildSurfacePipelines.get(guildId) === run) {
        this.guildSurfacePipelines.delete(guildId);
      }
    }
  }

  private async fetchGuildTextChannel(channelId: string): Promise<GuildTextBasedChannel | null> {
    const channel = await this.host.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel !== "object") {
      return null;
    }

    if (!("isTextBased" in channel) || typeof channel.isTextBased !== "function") {
      return null;
    }

    if (!channel.isTextBased() || !("send" in channel) || !("messages" in channel)) {
      return null;
    }

    return channel as GuildTextBasedChannel;
  }

  private async fetchMessage(
    channel: GuildTextBasedChannel,
    messageId: string
  ): Promise<ManagedMessage | null> {
    const fetched = await channel.messages.fetch(messageId).catch(() => null);
    if (!fetched) {
      return null;
    }

    return this.asManagedMessage(fetched);
  }

  private asManagedMessage(value: {
    id: string;
    channelId: string;
    edit(payload: unknown): Promise<unknown>;
    delete(): Promise<unknown>;
  }): ManagedMessage {
    return value;
  }

  private getGuild(guildId: string): Guild | null {
    return this.host.guilds.cache.get(guildId) ?? null;
  }

  private toSessionKey(guildId: string, slotId: string): string {
    return `${guildId}:${slotId}`;
  }
}
