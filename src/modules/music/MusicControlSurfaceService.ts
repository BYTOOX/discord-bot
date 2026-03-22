import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type StringSelectMenuInteraction
} from "discord.js";
import type { Logger } from "pino";

import type { AppConfig } from "../../config/env";
import type { AccessPolicyService } from "../policies/AccessPolicyService";
import { PANEL_BUTTONS, PANEL_SELECTS, buildMusicPanel } from "./MusicPanel";
import type { PanelState } from "./MusicPanel";
import type { MusicService } from "./MusicService";
import type { PanelRegistryService } from "./PanelRegistryService";
import type { SessionPanelRegistryService } from "./SessionPanelRegistryService";
import { displayTrack, formatDuration } from "./trackHelpers";
import type { MusicPanelDisplay } from "./types";

const COMMAND_CENTER_PREFIX = "command_center";
const CLEANUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const SESSION_AUTO_REMOVE_DELAY_MS = 90 * 1000;
const COMMAND_CENTER_COLOR = 0x19c2ff;
const SESSION_LIVE_COLOR = 0x2dd4bf;
const SESSION_IDLE_COLOR = 0xf59e0b;
const MAX_DISCORD_MESSAGE_EMBEDS = 10;
const COMMAND_CENTER_STATIC_EMBED_COUNT = 2;
const MAX_JUKEBOX_SLOT_EMBEDS = MAX_DISCORD_MESSAGE_EMBEDS - COMMAND_CENTER_STATIC_EMBED_COUNT;
const JUKEBOX_CARD_COLORS = [
  0xff6b6b,
  0x4dabf7,
  0x51cf66,
  0xf59f00,
  0x845ef7,
  0x2ec4b6,
  0xe8590c,
  0xf06595
] as const;

export const COMMAND_CENTER_BUTTONS = {
  refresh: `${COMMAND_CENTER_PREFIX}:refresh`,
  rebuild: `${COMMAND_CENTER_PREFIX}:rebuild`,
  clean: `${COMMAND_CENTER_PREFIX}:clean`
} as const;

const PUBLIC_PANEL_BUTTONS = new Set<string>([PANEL_BUTTONS.voteSkip, PANEL_BUTTONS.playlist]);
const PUBLIC_PANEL_SELECTS = new Set<string>([PANEL_SELECTS.jump]);

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
  getPanelStateForSession(guildId: string, slotId: string): Promise<PanelState>;
  getPanelDisplayForSession(guildId: string, slotId: string): Promise<MusicPanelDisplay | null>;
  handlePanelAction(
    interaction: ButtonInteraction
  ): Promise<{ message: string; state?: PanelState; disablePanel?: boolean }>;
  handlePanelSelectAction(
    interaction: StringSelectMenuInteraction
  ): Promise<{ message: string; state?: PanelState }>;
}

interface SurfaceHost {
  config: AppConfig;
  logger: Logger;
  accessPolicy: AccessPolicyService;
  musicService: MusicService;
  panelRegistryService: PanelRegistryService;
  sessionPanelRegistryService: SessionPanelRegistryService;
  user: {
    id: string;
  } | null;
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
  lastRender: SessionPanelRenderSnapshot | null;
}

interface SessionPanelRenderSnapshot {
  display: MusicPanelDisplay;
  state: PanelState;
}

interface SessionPayloadBuild {
  payload: unknown;
  lastRender: SessionPanelRenderSnapshot | null;
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

    await this.refreshGuild(guildId, "Command center online.");
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
          const payload = this.buildCommandCenterPayload(guildId, status);
          const editResult = await this.editManagedMessage(message, payload, {
            scope: "command-center",
            guildId
          });
          if (editResult === "ok") {
            updated = true;
          } else {
            this.commandCenterMessages.delete(guildId);
            const rebuilt = await this.ensureCommandCenterMessage(guildId, true);
            if (rebuilt) {
              const rebuildResult = await this.editManagedMessage(rebuilt, payload, {
                scope: "command-center-rebuild",
                guildId
              });
              updated = rebuildResult === "ok";
            }
          }
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
    await this.deleteKnownCommandCenterMessages(guildId);
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
    if (Object.values(COMMAND_CENTER_BUTTONS).includes(interaction.customId as never)) {
      return this.handleCommandCenterButtonInteraction(interaction);
    }

    if (!Object.values(PANEL_BUTTONS).includes(interaction.customId as never)) {
      return false;
    }

    return this.handleMusicPanelButtonInteraction(interaction);
  }

  public async handleStringSelectInteraction(
    interaction: StringSelectMenuInteraction
  ): Promise<boolean> {
    if (!Object.values(PANEL_SELECTS).includes(interaction.customId as never)) {
      return false;
    }

    return this.handleMusicPanelSelectInteraction(interaction);
  }

  private async handleCommandCenterButtonInteraction(
    interaction: ButtonInteraction
  ): Promise<boolean> {
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
          content: "Canal musique recycle.",
          flags: MessageFlags.Ephemeral
        });
        return true;
      default:
        return false;
    }
  }

  private async handleMusicPanelButtonInteraction(
    interaction: ButtonInteraction
  ): Promise<boolean> {
    if (!interaction.guild) {
      await interaction.reply({
        content: "Ce panneau ne fonctionne que sur un serveur.",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (this.panelInteractionRequiresDj(interaction.customId) &&
        !this.host.accessPolicy.canManagePlayback(member)) {
      await interaction.reply({
        content: "Il faut un role DJ ou la permission Gerer le serveur pour ce controle.",
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
    const result = await this.getPanelController().handlePanelAction(interaction);
    await this.refreshGuild(guildId, result.message);
    await interaction.followUp({
      content: result.message,
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  private async handleMusicPanelSelectInteraction(
    interaction: StringSelectMenuInteraction
  ): Promise<boolean> {
    if (!interaction.guild) {
      await interaction.reply({
        content: "Ce panneau ne fonctionne que sur un serveur.",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (this.panelInteractionRequiresDj(interaction.customId) &&
        !this.host.accessPolicy.canManagePlayback(member)) {
      await interaction.reply({
        content: "Il faut un role DJ ou la permission Gerer le serveur pour ce controle.",
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
    const result = await this.getPanelController().handlePanelSelectAction(interaction);
    await this.refreshGuild(guildId, result.message);
    await interaction.followUp({
      content: result.message,
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  private panelInteractionRequiresDj(customId: string): boolean {
    if (PUBLIC_PANEL_BUTTONS.has(customId) || PUBLIC_PANEL_SELECTS.has(customId)) {
      return false;
    }

    return true;
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

    if (forceRebuild) {
      await this.deleteKnownCommandCenterMessages(guildId, channel);
    }

    if (!forceRebuild) {
      const existing = this.commandCenterMessages.get(guildId);
      if (existing && existing.channelId === channel.id) {
        const resolved = await this.fetchMessage(channel, existing.messageId);
        if (resolved) {
          return resolved;
        }
      }

       const registered = await this.host.panelRegistryService.get(guildId);
       if (registered && registered.channelId === channel.id) {
         const resolved = await this.fetchMessage(channel, registered.messageId);
         if (resolved) {
           this.commandCenterMessages.set(guildId, {
             channelId: registered.channelId,
             messageId: registered.messageId
           });
           return resolved;
         }

         this.host.panelRegistryService.reportInvalid(
           guildId,
           registered.channelId,
           registered.messageId
         );
         await this.host.panelRegistryService.clear(guildId);
       }
    }

    const message = await channel.send(this.buildCommandCenterPayload(guildId, "Boot sync."));
    const managed = this.asManagedMessage(message);
    await this.rememberCommandCenterMessage(guildId, channel.id, managed.id);
    await this.deleteDuplicateCommandCenterMessages(channel, managed.id);
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
      message = await this.resolveRegisteredSessionPanel(snapshot, channel);
    }

    if (!message) {
      message = await this.recoverSessionPanelMessage(snapshot, channel);
    }

    const build = await this.buildSessionPayload(snapshot, status);

    if (!message) {
      const created = await channel.send(build.payload as never);
      const managed = this.asManagedMessage(created);
      this.cancelSessionDeletion(key);
      await this.rememberSessionPanelMessage(snapshot, managed, build.lastRender);
      await this.deleteDuplicateSessionPanelMessages(channel, snapshot, managed.id);
      return;
    }

    this.cancelSessionDeletion(key);
    const editResult = await this.editManagedMessage(
      message,
      build.payload,
      {
        scope: "session-panel",
        guildId: snapshot.guildId,
        slotId: snapshot.slotId
      }
    );

    if (editResult === "ok") {
      await this.rememberSessionPanelMessage(snapshot, message, build.lastRender);
      return;
    }

    if (editResult === "missing") {
      await this.host.sessionPanelRegistryService.clear(snapshot.guildId, snapshot.slotId);
      const created = await channel.send(build.payload as never);
      const managed = this.asManagedMessage(created);
      await this.rememberSessionPanelMessage(snapshot, managed, build.lastRender);
      await this.deleteDuplicateSessionPanelMessages(channel, snapshot, managed.id);
    }
  }

  private async scheduleSessionRemoval(key: string, reason: string): Promise<void> {
    const existing = this.sessionPanels.get(key);
    if (!existing) {
      return;
    }

    this.cancelSessionDeletion(key);
    await this.clearSessionPanelRegistration(key);

    const channel = await this.fetchGuildTextChannel(existing.channelId);
    const message = channel ? await this.fetchMessage(channel, existing.messageId) : null;
    if (message) {
      const closedPayload = existing.lastRender
        ? buildMusicPanel(
            existing.lastRender.display,
            this.host.config.musicPanelEmoji,
            existing.lastRender.state,
            reason,
            true
          )
        : this.buildSessionClosedPayload(reason);
      const editResult = await this.editManagedMessage(
        message,
        closedPayload,
        {
          scope: "session-close",
          key
        }
      );
      if (editResult === "missing") {
        this.sessionPanels.delete(key);
        return;
      }
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
    await this.clearSessionPanelRegistration(key);
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

    await this.deleteKnownCommandCenterMessages(guildId, channel);
    this.commandCenterMessages.delete(guildId);
    await this.host.panelRegistryService.clear(guildId);
  }

  private getPanelController(): Pick<
    MusicService | ControlSurfaceCoordinator,
    "handlePanelAction" | "handlePanelSelectAction"
  > {
    return this.coordinator ?? this.host.musicService;
  }

  private async rememberCommandCenterMessage(
    guildId: string,
    channelId: string,
    messageId: string
  ): Promise<void> {
    this.commandCenterMessages.set(guildId, { channelId, messageId });
    await this.host.panelRegistryService.set(guildId, channelId, messageId);
  }

  private async deleteKnownCommandCenterMessages(
    guildId: string,
    channel?: GuildTextBasedChannel
  ): Promise<void> {
    const resolvedChannel =
      channel ??
      (this.host.config.musicControlChannelId
        ? await this.fetchGuildTextChannel(this.host.config.musicControlChannelId)
        : null);

    const inMemory = this.commandCenterMessages.get(guildId);
    if (resolvedChannel && inMemory) {
      const existing = await this.fetchMessage(resolvedChannel, inMemory.messageId);
      if (existing) {
        await existing.delete().catch(() => null);
      }
    }

    const registered = await this.host.panelRegistryService.get(guildId);
    if (resolvedChannel && registered && registered.channelId === resolvedChannel.id) {
      const existing = await this.fetchMessage(resolvedChannel, registered.messageId);
      if (existing) {
        await existing.delete().catch(() => null);
      }
    }

    if (resolvedChannel) {
      await this.deleteDuplicateCommandCenterMessages(resolvedChannel);
    }

    this.commandCenterMessages.delete(guildId);
    await this.host.panelRegistryService.clear(guildId);
  }

  private async deleteDuplicateCommandCenterMessages(
    channel: GuildTextBasedChannel,
    keepMessageId?: string
  ): Promise<void> {
    const batch = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!batch) {
      return;
    }

    const duplicates = batch.filter((message) => {
      if (keepMessageId && message.id === keepMessageId) {
        return false;
      }

      return this.isCommandCenterMessage(message);
    });

    await Promise.allSettled(
      duplicates.map((message) => message.delete().catch(() => null))
    );
  }

  private async deleteDuplicateSessionPanelMessages(
    channel: GuildTextBasedChannel,
    snapshot: JukeboxSessionSnapshot,
    keepMessageId?: string
  ): Promise<void> {
    const batch = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!batch) {
      return;
    }

    const duplicates = batch.filter((message) => {
      if (keepMessageId && message.id === keepMessageId) {
        return false;
      }

      return this.isSessionPanelMessage(message, snapshot);
    });

    await Promise.allSettled(duplicates.map((message) => message.delete().catch(() => null)));
  }

  private isCommandCenterMessage(message: Message): boolean {
    if (message.author.id !== this.host.user?.id) {
      return false;
    }

    return message.components.some((row) => {
      if (!("components" in row) || !Array.isArray(row.components)) {
        return false;
      }

      return row.components.some((component: { customId?: string | null }) =>
        component.customId?.startsWith(`${COMMAND_CENTER_PREFIX}:`) ?? false
      );
    });
  }

  private isSessionPanelMessage(message: Message, snapshot: JukeboxSessionSnapshot): boolean {
    if (message.author.id !== this.host.user?.id) {
      return false;
    }

    if (this.isCommandCenterMessage(message)) {
      return false;
    }

    const hasMusicPanelControls = message.components.some((row) => {
      if (!("components" in row) || !Array.isArray(row.components)) {
        return false;
      }

      return row.components.some((component: { customId?: string | null }) => {
        const customId = component.customId;
        if (!customId) {
          return false;
        }

        return (
          Object.values(PANEL_BUTTONS).includes(customId as never) ||
          Object.values(PANEL_SELECTS).includes(customId as never)
        );
      });
    });

    if (hasMusicPanelControls) {
      return true;
    }

    const embedTitles = message.embeds
      .map((embed) => embed.title?.trim().toLowerCase() ?? "")
      .filter((title) => title.length > 0);
    const normalizedCallsign = snapshot.callsign.trim().toLowerCase();

    return (
      embedTitles.some((title) => title.includes("quantum neural deck")) ||
      embedTitles.some((title) => title.includes("file d'attente")) ||
      embedTitles.some((title) => normalizedCallsign.length > 0 && title.includes(normalizedCallsign))
    );
  }

  private async resolveRegisteredSessionPanel(
    snapshot: JukeboxSessionSnapshot,
    channel: GuildTextBasedChannel
  ): Promise<ManagedMessage | null> {
    const registered = await this.host.sessionPanelRegistryService.get(
      snapshot.guildId,
      snapshot.slotId
    );
    if (!registered) {
      return null;
    }

    if (registered.channelId !== channel.id) {
      await this.host.sessionPanelRegistryService.clear(snapshot.guildId, snapshot.slotId);
      return null;
    }

    const resolved = await this.fetchMessage(channel, registered.messageId);
    if (resolved) {
      this.sessionPanels.set(this.toSessionKey(snapshot.guildId, snapshot.slotId), {
        channelId: registered.channelId,
        messageId: registered.messageId,
        deleteTimer: null,
        lastRender: null
      });
      return resolved;
    }

    this.host.sessionPanelRegistryService.reportInvalid(
      snapshot.guildId,
      snapshot.slotId,
      registered.channelId,
      registered.messageId
    );
    await this.host.sessionPanelRegistryService.clear(snapshot.guildId, snapshot.slotId);
    return null;
  }

  private async recoverSessionPanelMessage(
    snapshot: JukeboxSessionSnapshot,
    channel: GuildTextBasedChannel
  ): Promise<ManagedMessage | null> {
    const batch = await channel.messages.fetch({ limit: 25 }).catch(() => null);
    if (!batch) {
      return null;
    }

    const recovered = [...batch.values()]
      .filter((message) => this.isSessionPanelMessage(message, snapshot))
      .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0];
    if (!recovered) {
      return null;
    }

    const managed = this.asManagedMessage(recovered);
    await this.host.sessionPanelRegistryService.set(
      snapshot.guildId,
      snapshot.slotId,
      channel.id,
      managed.id
    );
    this.sessionPanels.set(this.toSessionKey(snapshot.guildId, snapshot.slotId), {
      channelId: channel.id,
      messageId: managed.id,
      deleteTimer: null,
      lastRender: null
    });
    this.logger.info(
      {
        guildId: snapshot.guildId,
        slotId: snapshot.slotId,
        channelId: channel.id,
        messageId: managed.id
      },
      "Panneau de session recupere depuis le salon vocal"
    );
    return managed;
  }

  private async rememberSessionPanelMessage(
    snapshot: JukeboxSessionSnapshot,
    message: ManagedMessage,
    lastRender: SessionPanelRenderSnapshot | null
  ): Promise<void> {
    const key = this.toSessionKey(snapshot.guildId, snapshot.slotId);
    this.sessionPanels.set(key, {
      channelId: message.channelId,
      messageId: message.id,
      deleteTimer: null,
      lastRender
    });
    await this.host.sessionPanelRegistryService.set(
      snapshot.guildId,
      snapshot.slotId,
      message.channelId,
      message.id
    );
  }

  private async clearSessionPanelRegistration(key: string): Promise<void> {
    const { guildId, slotId } = this.parseSessionKey(key);
    if (!guildId || !slotId) {
      return;
    }

    await this.host.sessionPanelRegistryService.clear(guildId, slotId);
  }

  private async buildSessionPayload(
    snapshot: JukeboxSessionSnapshot,
    status?: string
  ): Promise<SessionPayloadBuild> {
    const panel = await this.resolveSessionPanelRender(snapshot, status);
    if (panel) {
      return panel;
    }

    return {
      payload: this.buildLegacySessionPayload(snapshot, status),
      lastRender: null
    };
  }

  private async resolveSessionPanelRender(
    snapshot: JukeboxSessionSnapshot,
    status?: string
  ): Promise<SessionPayloadBuild | null> {
    const renderState = await this.resolveSessionPanelState(snapshot);
    if (!renderState) {
      return null;
    }

    return {
      payload: buildMusicPanel(
        renderState.display,
        this.host.config.musicPanelEmoji,
        renderState.state,
        status
      ),
      lastRender: renderState
    };
  }

  private async resolveSessionPanelState(
    snapshot: JukeboxSessionSnapshot
  ): Promise<SessionPanelRenderSnapshot | null> {
    if (this.coordinator) {
      const [display, state] = await Promise.all([
        this.coordinator.getPanelDisplayForSession(snapshot.guildId, snapshot.slotId),
        this.coordinator.getPanelStateForSession(snapshot.guildId, snapshot.slotId)
      ]);
      if (!display) {
        return null;
      }

      return { display, state };
    }

    const [display, state] = await Promise.all([
      this.host.musicService.getPanelDisplay(snapshot.guildId),
      this.host.musicService.getPanelState(snapshot.guildId)
    ]);
    if (!display) {
      return null;
    }

    return { display, state };
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
    const visibleSlots = slotSnapshots.slice(0, MAX_JUKEBOX_SLOT_EMBEDS);
    const hiddenSlotCount = Math.max(0, slotSnapshots.length - visibleSlots.length);
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

    if (hiddenSlotCount > 0) {
      heroEmbed.addFields({
        name: "Parc",
        value: `+${hiddenSlotCount} jukebox non affiches (limite Discord).`,
        inline: false
      });
    }

    const slotEmbeds = this.buildJukeboxEmbeds(visibleSlots, slotSnapshots.length);

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
      embeds: [heroEmbed, ...slotEmbeds, sessionsEmbed],
      components: [this.buildCommandCenterActions()]
    };
  }

  private buildJukeboxEmbeds(
    slotSnapshots: JukeboxSlotSnapshot[],
    totalSlots: number
  ): EmbedBuilder[] {
    if (slotSnapshots.length === 0) {
      return [
        new EmbedBuilder()
          .setColor(COMMAND_CENTER_COLOR)
          .setTitle("Parc Jukebox")
          .setDescription("Aucun jukebox detecte.")
      ];
    }

    return slotSnapshots.map((slot, index) =>
      new EmbedBuilder()
        .setColor(this.resolveJukeboxCardColor(slot, index))
        .setTitle(`${this.getSlotEmoji(slot.mode)} ${slot.callsign}`)
        .setDescription(slot.currentTrack ? this.truncate(slot.currentTrack, 120) : "Aucune piste.")
        .addFields(
          {
            name: "Etat",
            value: this.formatSlotMode(slot.mode),
            inline: true
          },
          {
            name: "File",
            value: `${slot.queueDepth} piste(s)`,
            inline: true
          },
          {
            name: "Vocal",
            value: slot.voiceChannelId ? `<#${slot.voiceChannelId}>` : "Libre",
            inline: true
          }
        )
        .setFooter({ text: `Jukebox ${index + 1}/${Math.max(totalSlots, 1)}` })
    );
  }

  private buildLegacySessionPayload(snapshot: JukeboxSessionSnapshot, status?: string) {
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

  private resolveJukeboxCardColor(slot: JukeboxSlotSnapshot, fallbackIndex: number): number {
    const colorIndex = this.resolveJukeboxColorIndex(slot.slotId, fallbackIndex);
    const baseColor = JUKEBOX_CARD_COLORS[colorIndex % JUKEBOX_CARD_COLORS.length] ?? COMMAND_CENTER_COLOR;

    switch (slot.mode) {
      case "offline":
        return this.scaleColor(baseColor, 0.45);
      case "paused":
        return this.scaleColor(baseColor, 0.7);
      case "assigned":
        return this.scaleColor(baseColor, 0.82);
      default:
        return baseColor;
    }
  }

  private resolveJukeboxColorIndex(slotId: string, fallbackIndex: number): number {
    const numericSuffix = slotId.match(/(\d+)$/)?.[1];
    if (numericSuffix) {
      const parsed = Number.parseInt(numericSuffix, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed - 1;
      }
    }

    let hash = 0;
    for (const char of slotId) {
      hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    }

    return Math.abs(hash) + fallbackIndex;
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

  private scaleColor(color: number, factor: number): number {
    const safeFactor = Math.max(0, Math.min(1.5, factor));
    const red = Math.min(255, Math.round(((color >> 16) & 0xff) * safeFactor));
    const green = Math.min(255, Math.round(((color >> 8) & 0xff) * safeFactor));
    const blue = Math.min(255, Math.round((color & 0xff) * safeFactor));
    return (red << 16) | (green << 8) | blue;
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

  private async editManagedMessage(
    message: ManagedMessage,
    payload: unknown,
    context: Record<string, unknown>
  ): Promise<"ok" | "missing"> {
    try {
      await message.edit(payload);
      return "ok";
    } catch (error) {
      if (this.isUnknownMessageError(error)) {
        this.logger.warn(
          { ...context, channelId: message.channelId, messageId: message.id, err: error },
          "Message Discord introuvable pendant mise a jour surface"
        );
        return "missing";
      }

      throw error;
    }
  }

  private isUnknownMessageError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const candidate = error as {
      code?: unknown;
      status?: unknown;
      message?: unknown;
      rawError?: { code?: unknown; message?: unknown } | null;
    };

    const errorCode = candidate.code ?? candidate.rawError?.code;
    if (errorCode === 10008) {
      return true;
    }

    const statusCode = candidate.status;
    if (statusCode === 404) {
      const messageText =
        typeof candidate.message === "string"
          ? candidate.message
          : typeof candidate.rawError?.message === "string"
            ? candidate.rawError.message
            : "";
      return messageText.toLowerCase().includes("unknown message");
    }

    return false;
  }

  private getGuild(guildId: string): Guild | null {
    return this.host.guilds.cache.get(guildId) ?? null;
  }

  private toSessionKey(guildId: string, slotId: string): string {
    return `${guildId}:${slotId}`;
  }

  private parseSessionKey(key: string): { guildId: string; slotId: string } {
    const separator = key.indexOf(":");
    if (separator < 0) {
      return { guildId: "", slotId: "" };
    }

    return {
      guildId: key.slice(0, separator),
      slotId: key.slice(separator + 1)
    };
  }
}
