import {
  AttachmentBuilder,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type StringSelectMenuInteraction
} from "discord.js";
import type { Logger } from "pino";

import type { AppConfig } from "../config/env";
import { PostgresService } from "../modules/infrastructure/PostgresService";
import { RedisLockService } from "../modules/infrastructure/RedisLockService";
import { CustomPlaylistService } from "../modules/playlists/CustomPlaylistService";
import { AccessPolicyService } from "../modules/policies/AccessPolicyService";
import { ProviderResolver } from "../modules/providers/ProviderResolver";
import { GuildSettingsService } from "../modules/music/GuildSettingsService";
import { LavalinkService } from "../modules/music/LavalinkService";
import { MusicService } from "../modules/music/MusicService";
import { PanelRegistryService, type RegisteredPanel } from "../modules/music/PanelRegistryService";
import type { MusicPanelDisplay } from "../modules/music/types";
import {
  buildMusicPanel,
  isMusicPanelAction,
  isMusicPanelSelectAction,
  PANEL_BUTTONS,
  type PanelState
} from "../modules/music/MusicPanel";
import { renderMusicPanelImage } from "../modules/music/MusicPanelImage";
import { CommandRegistry } from "./CommandRegistry";
import { sendReply } from "./interactionReply";
import type { SlashCommand } from "./types";

const PANEL_LIVE_REFRESH_MS = 7_000;
const INTERACTION_LOCK_TTL_MS = 20_000;
const PANEL_BUSY_LOCK_TTL_MS = 8_000;
const COMMAND_PUBLISH_LOCK_TTL_MS = 90_000;

export class QuantumClient extends Client {
  public readonly config: AppConfig;
  public readonly logger: Logger;
  public readonly commands = new Collection<string, SlashCommand>();
  public readonly postgresService: PostgresService;
  public readonly redisLockService: RedisLockService;
  public readonly commandRegistry: CommandRegistry;
  public readonly accessPolicy: AccessPolicyService;
  public readonly playlistService: CustomPlaylistService;
  public readonly guildSettingsService: GuildSettingsService;
  public readonly providerResolver: ProviderResolver;
  public readonly panelRegistryService: PanelRegistryService;
  public readonly lavalinkService: LavalinkService;
  public readonly musicService: MusicService;
  private eventHandlersBound = false;
  private readonly activeMusicPanels = new Map<string, { channelId: string; messageId: string }>();
  private panelLiveTicker: NodeJS.Timeout | null = null;

  public constructor(config: AppConfig, logger: Logger) {
    super({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
    });

    this.config = config;
    this.logger = logger;
    this.postgresService = new PostgresService(config.postgresUrl, logger.child({ scope: "postgres" }));
    this.redisLockService = new RedisLockService(config.redisUrl, logger.child({ scope: "redis" }));
    this.commandRegistry = new CommandRegistry(config, logger.child({ scope: "commands" }));
    this.accessPolicy = new AccessPolicyService(config);
    this.playlistService = new CustomPlaylistService(
      this.postgresService,
      {
        maxPlaylists: config.maxCustomPlaylists,
        maxTracksPerPlaylist: config.maxTracksPerPlaylist
      },
      logger.child({ scope: "playlists" })
    );
    this.guildSettingsService = new GuildSettingsService(
      this.postgresService,
      {
        autoplay: config.autoplayDefault,
        stayInVoice: config.stayInVoiceDefault,
        volume: config.defaultVolume
      },
      logger.child({ scope: "guild-settings" })
    );
    this.providerResolver = new ProviderResolver();
    this.panelRegistryService = new PanelRegistryService(
      this.postgresService,
      logger.child({ scope: "panel-registry" })
    );
    this.lavalinkService = new LavalinkService(this, config, logger.child({ scope: "lavalink" }));
    this.musicService = new MusicService(
      this.lavalinkService,
      this.providerResolver,
      this.playlistService,
      this.guildSettingsService,
      config.playerEmptyTimeoutMs,
      config.playerSelfDeaf,
      logger.child({ scope: "music" })
    );
  }

  public registerCommands(commands: SlashCommand[]): void {
    for (const command of commands) {
      this.commands.set(command.data.name, command);
    }
    this.commandRegistry.setCommands(commands);
  }

  public async start(): Promise<void> {
    await this.postgresService.initialize();
    await this.redisLockService.initialize();
    this.bindEvents();
    await this.login(this.config.discordToken);
  }

  public async registerMusicPanelMessage(
    guildId: string,
    channelId: string,
    messageId: string
  ): Promise<void> {
    this.activeMusicPanels.set(guildId, { channelId, messageId });
    await this.panelRegistryService.set(guildId, channelId, messageId);
  }

  public async getRegisteredMusicPanel(
    guildId: string
  ): Promise<{ channelId: string; messageId: string } | null> {
    const cached = this.activeMusicPanels.get(guildId);
    if (cached) {
      return cached;
    }

    const stored = await this.panelRegistryService.get(guildId);
    if (!stored) {
      return null;
    }

    const value = { channelId: stored.channelId, messageId: stored.messageId };
    this.activeMusicPanels.set(guildId, value);
    return value;
  }

  public async clearRegisteredMusicPanel(guildId: string): Promise<boolean> {
    this.activeMusicPanels.delete(guildId);
    return this.panelRegistryService.clear(guildId);
  }

  public async getPanelDisplayOrFallback(
    guildId: string,
    requestedById?: string
  ): Promise<MusicPanelDisplay> {
    const liveDisplay = await this.musicService.getPanelDisplay(guildId);
    if (liveDisplay) {
      return liveDisplay;
    }

    return this.buildIdlePanelDisplay(guildId, requestedById);
  }

  public async refreshRegisteredMusicPanel(guildId: string, status?: string): Promise<boolean> {
    const target = await this.getRegisteredMusicPanel(guildId);
    if (!target) {
      return false;
    }

    try {
      const channel = await this.channels.fetch(target.channelId);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) {
        await this.clearRegisteredMusicPanel(guildId);
        this.panelRegistryService.reportInvalid(guildId, target.channelId, target.messageId);
        return false;
      }

      const message = await channel.messages.fetch(target.messageId);
      const panelState = await this.musicService.getPanelState(guildId);
      const liveDisplay = await this.musicService.getPanelDisplay(guildId);
      const panelDisplay = liveDisplay ?? (await this.buildIdlePanelDisplay(guildId));

      const panel = buildMusicPanel(
        panelDisplay,
        this.config.musicPanelEmoji,
        panelState,
        status,
        !liveDisplay
      );
      const panelImageAttachment = await this.buildPanelImageAttachment(
        guildId,
        panelDisplay,
        panelState,
        status
      );
      await message.edit({
        content: null,
        components: panel.components,
        embeds: [],
        flags: panel.flags,
        attachments: [],
        files: panelImageAttachment ? [panelImageAttachment] : []
      });
      return true;
    } catch (error) {
      this.logger.warn({ err: error, guildId }, "Impossible de rafraichir le panneau musique");
      await this.clearRegisteredMusicPanel(guildId);
      return false;
    }
  }

  private bindEvents(): void {
    if (this.eventHandlersBound) {
      return;
    }

    this.once(Events.ClientReady, async (readyClient) => {
      this.logger.info(
        { username: readyClient.user.tag, guildCount: readyClient.guilds.cache.size },
        "Client Discord pret"
      );

      await this.musicService.initialize(readyClient.user.id, readyClient.user.username);

      const publishLockKey = `commands:publish:${this.config.discordGuildId}`;
      const publishToken = await this.redisLockService.acquire(
        publishLockKey,
        COMMAND_PUBLISH_LOCK_TTL_MS
      );

      if (!publishToken) {
        this.logger.info("Publication des commandes ignoree: un replica est deja en charge.");
        return;
      }

      try {
        await this.commandRegistry.publish();
      } finally {
        await this.redisLockService.release(publishLockKey, publishToken);
      }
    });

    this.on(Events.Raw, (payload) => {
      void this.musicService.forwardRawEvent(payload);
    });

    this.on(Events.InteractionCreate, (interaction: Interaction) => {
      void this.handleInteraction(interaction);
    });

    this.on(Events.Warn, (warning) => {
      this.logger.warn({ warning }, "Avertissement client Discord");
    });

    this.on(Events.Error, (error) => {
      this.logger.error({ err: error }, "Erreur client Discord");
    });

    this.lavalinkService.manager.on("trackStart", (player) => {
      void this.refreshRegisteredMusicPanel(player.guildId, "Lecture mise a jour.");
    });

    this.lavalinkService.manager.on("queueEnd", (player) => {
      void this.refreshRegisteredMusicPanel(player.guildId, "File terminee.");
    });

    this.lavalinkService.manager.on("playerDestroy", (player) => {
      void this.refreshRegisteredMusicPanel(player.guildId, "Player deconnecte.");
    });

    this.startPanelLiveTicker();
    this.eventHandlersBound = true;
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    const lockKey = `interaction:${interaction.id}`;
    const lockToken = await this.redisLockService.acquire(lockKey, INTERACTION_LOCK_TTL_MS);
    if (!lockToken) {
      return;
    }

    try {
      if (interaction.isButton()) {
        await this.handleButtonInteraction(interaction);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        await this.handleSelectInteraction(interaction);
        return;
      }

      if (!interaction.isChatInputCommand()) {
        return;
      }

      const command = this.commands.get(interaction.commandName);
      if (!command) {
        await sendReply(interaction, {
          content: "Commande inconnue.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      try {
        await command.execute(interaction, this);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erreur de commande inattendue.";
        this.logger.error(
          {
            err: error,
            command: command.data.name,
            guildId: interaction.guildId,
            userId: interaction.user.id
          },
          "Echec execution commande"
        );
        await sendReply(interaction, {
          content: `Erreur: ${message}`,
          flags: MessageFlags.Ephemeral
        });
      }
    } finally {
      await this.redisLockService.release(lockKey, lockToken);
    }
  }

  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    if (!isMusicPanelAction(interaction.customId)) {
      return;
    }

    let busyToken: string | null = null;

    try {
      if (!interaction.guild) {
        await interaction.reply({
          content: "Ce bouton ne peut etre utilise que sur un serveur.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({
          content: "Impossible de determiner le serveur pour ce panneau.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      const bypassDjCheck = interaction.customId === PANEL_BUTTONS.voteSkip;
      if (!bypassDjCheck && !this.accessPolicy.canManagePlayback(member)) {
        await interaction.reply({
          content: "Il faut un role DJ ou la permission Gerer le serveur.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      busyToken = await this.redisLockService.acquire(
        `panel:busy:${guildId}:${interaction.message.id}`,
        PANEL_BUSY_LOCK_TTL_MS
      );
      if (!busyToken) {
        await interaction.reply({
          content: "Une action est deja en cours sur ce panneau, reessaie dans une seconde.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferUpdate();
      const result = await this.musicService.handlePanelAction(interaction);
      await this.registerMusicPanelMessage(guildId, interaction.channelId, interaction.message.id);
      await this.refreshRegisteredMusicPanel(guildId, result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur bouton inattendue.";
      this.logger.error(
        {
          err: error,
          customId: interaction.customId,
          guildId: interaction.guildId,
          userId: interaction.user.id
        },
        "Echec interaction bouton"
      );

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `Erreur: ${message}`, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: `Erreur: ${message}`, flags: MessageFlags.Ephemeral });
      }
    } finally {
      if (busyToken && interaction.guildId) {
        await this.redisLockService.release(
          `panel:busy:${interaction.guildId}:${interaction.message.id}`,
          busyToken
        );
      }
    }
  }

  private async handleSelectInteraction(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!isMusicPanelSelectAction(interaction.customId)) {
      return;
    }

    let busyToken: string | null = null;

    try {
      if (!interaction.guild) {
        await interaction.reply({
          content: "Ce menu ne peut etre utilise que sur un serveur.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({
          content: "Impossible de determiner le serveur pour ce panneau.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!this.accessPolicy.canManagePlayback(member)) {
        await interaction.reply({
          content: "Il faut un role DJ ou la permission Gerer le serveur.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      busyToken = await this.redisLockService.acquire(
        `panel:busy:${guildId}:${interaction.message.id}`,
        PANEL_BUSY_LOCK_TTL_MS
      );
      if (!busyToken) {
        await interaction.reply({
          content: "Une action est deja en cours sur ce panneau, reessaie dans une seconde.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferUpdate();
      const result = await this.musicService.handlePanelSelectAction(interaction);
      await this.registerMusicPanelMessage(guildId, interaction.channelId, interaction.message.id);
      await this.refreshRegisteredMusicPanel(guildId, result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur menu inattendue.";
      this.logger.error(
        {
          err: error,
          customId: interaction.customId,
          guildId: interaction.guildId,
          userId: interaction.user.id
        },
        "Echec interaction menu panneau"
      );

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `Erreur: ${message}`, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: `Erreur: ${message}`, flags: MessageFlags.Ephemeral });
      }
    } finally {
      if (busyToken && interaction.guildId) {
        await this.redisLockService.release(
          `panel:busy:${interaction.guildId}:${interaction.message.id}`,
          busyToken
        );
      }
    }
  }

  private async buildIdlePanelDisplay(
    guildId: string,
    requestedById?: string
  ): Promise<MusicPanelDisplay> {
    const settings = await this.guildSettingsService.get(guildId);
    const state = await this.musicService.getPanelState(guildId);
    const player = this.musicService.getPlayer(guildId);
    const queue = this.musicService.getQueueSummary(guildId, 5);

    const repeatLabel =
      state.repeatMode === "off"
        ? "Arret"
        : state.repeatMode === "track"
          ? "Piste"
          : "File";
    const playbackLabel = state.paused ? "Pause" : player?.playing ? "Lecture" : "Veille";
    const volume = player?.volume ?? settings.volume;

    const modeLines = [
      `Etat: ${playbackLabel}`,
      `Boucle: ${repeatLabel}`,
      `Autoplay: ${state.autoplay ? "ON" : "OFF"}`,
      `Mode 24/7: ${settings.stayInVoice ? "ON" : "OFF"}`,
      `Volume: ${volume}%`
    ];

    const playlistLines: string[] = [];
    if (queue.current) {
      playlistLines.push(`Now: ${queue.current}`);
    }

    if (queue.upcoming.length > 0) {
      playlistLines.push("A suivre:");
      playlistLines.push(...queue.upcoming);
    }

    if (playlistLines.length === 0) {
      playlistLines.push("File vide pour le moment.");
    }

    const display: MusicPanelDisplay = {
      trackTitle: "Aucune piste en cours",
      trackAuthor: "Ajoute une musique pour lancer la lecture.",
      trackDurationMs: 0,
      trackPositionMs: 0,
      isPlaying: false,
      isPaused: false,
      accentColor: 0x2b90ff,
      sourceName: "youtube",
      modeInfo: modeLines.join("\n"),
      playlistInfo: playlistLines.join("\n"),
      queueHealthInfo: `Etat: Veille\nPistes en attente: ${queue.upcoming.length}\nTemps restant: 0:00\nErreurs recentes: non`,
      sessionInfo: "Session en attente.\nLance une piste pour demarrer le suivi.",
      voteSkipInfo: "Progression: 0/1\nSeuil: 1 vote(s)\nVotants: Aucun vote pour le moment.",
      jumpTargets: []
    };

    if (requestedById) {
      display.requestedById = requestedById;
    }

    return display;
  }

  private startPanelLiveTicker(): void {
    if (this.panelLiveTicker) {
      return;
    }

    this.panelLiveTicker = setInterval(() => {
      void this.refreshActivePanelsTick();
    }, PANEL_LIVE_REFRESH_MS);
    this.panelLiveTicker.unref?.();
  }

  private async refreshActivePanelsTick(): Promise<void> {
    const guildIds = await this.panelRegistryService.listGuildIds();
    if (guildIds.length === 0) {
      return;
    }

    for (const guildId of guildIds) {
      const player = this.musicService.getPlayer(guildId);
      if (!player?.playing) {
        continue;
      }

      await this.refreshRegisteredMusicPanel(guildId);
    }
  }

  private async buildPanelImageAttachment(
    guildId: string,
    panelDisplay: MusicPanelDisplay,
    panelState: PanelState,
    status?: string
  ): Promise<AttachmentBuilder | null> {
    try {
      const panelImage = await renderMusicPanelImage(panelDisplay, panelState, status);
      return new AttachmentBuilder(panelImage, { name: "quantum-panel-v4.png" });
    } catch (error) {
      this.logger.warn({ err: error, guildId }, "Echec rendu image panel musique");
      return null;
    }
  }
}


