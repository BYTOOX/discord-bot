import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  type ButtonInteraction,
  type Interaction,
  type StringSelectMenuInteraction
} from "discord.js";
import type { Logger } from "pino";

import type { AppConfig } from "../config/env";
import { AccessPolicyService } from "../modules/policies/AccessPolicyService";
import { sendReply } from "./interactionReply";
import { CommandRegistry } from "./CommandRegistry";
import type { SlashCommand } from "./types";
import { ProviderResolver } from "../modules/providers/ProviderResolver";
import { CustomPlaylistService } from "../modules/playlists/CustomPlaylistService";
import { GuildSettingsService } from "../modules/music/GuildSettingsService";
import { LavalinkService } from "../modules/music/LavalinkService";
import { MusicService } from "../modules/music/MusicService";
import type { MusicPanelDisplay } from "../modules/music/types";
import {
  buildMusicPanel,
  isMusicPanelAction,
  isMusicPanelSelectAction,
  PANEL_BUTTONS
} from "../modules/music/MusicPanel";

const PANEL_LIVE_REFRESH_MS = 7_000;

export class QuantumClient extends Client {
  public readonly config: AppConfig;
  public readonly logger: Logger;
  public readonly commands = new Collection<string, SlashCommand>();
  public readonly commandRegistry: CommandRegistry;
  public readonly accessPolicy: AccessPolicyService;
  public readonly playlistService: CustomPlaylistService;
  public readonly guildSettingsService: GuildSettingsService;
  public readonly providerResolver: ProviderResolver;
  public readonly lavalinkService: LavalinkService;
  public readonly musicService: MusicService;
  private eventHandlersBound = false;
  private readonly panelBusyMessages = new Set<string>();
  private readonly activeMusicPanels = new Map<string, { channelId: string; messageId: string }>();
  private panelLiveTicker: NodeJS.Timeout | null = null;

  public constructor(config: AppConfig, logger: Logger) {
    super({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
    });

    this.config = config;
    this.logger = logger;
    this.commandRegistry = new CommandRegistry(config, logger.child({ scope: "commands" }));
    this.accessPolicy = new AccessPolicyService(config);
    this.playlistService = new CustomPlaylistService(
      config.playlistStorePath,
      {
        maxPlaylists: config.maxCustomPlaylists,
        maxTracksPerPlaylist: config.maxTracksPerPlaylist
      },
      logger.child({ scope: "playlists" })
    );
    this.guildSettingsService = new GuildSettingsService(
      config.guildSettingsStorePath,
      {
        autoplay: config.autoplayDefault,
        stayInVoice: config.stayInVoiceDefault,
        volume: config.defaultVolume
      },
      logger.child({ scope: "guild-settings" })
    );
    this.providerResolver = new ProviderResolver();
    this.lavalinkService = new LavalinkService(this, config, logger.child({ scope: "lavalink" }));
    this.musicService = new MusicService(
      this.lavalinkService,
      this.providerResolver,
      this.playlistService,
      this.guildSettingsService,
      config.playerEmptyTimeoutMs,
      config.playerSelfDeaf,
      config.youtubeFallbackSource,
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
    this.bindEvents();
    await this.login(this.config.discordToken);
  }

  public registerMusicPanelMessage(guildId: string, channelId: string, messageId: string): void {
    this.activeMusicPanels.set(guildId, { channelId, messageId });
  }

  public getRegisteredMusicPanel(guildId: string): { channelId: string; messageId: string } | null {
    return this.activeMusicPanels.get(guildId) ?? null;
  }

  public clearRegisteredMusicPanel(guildId: string): boolean {
    return this.activeMusicPanels.delete(guildId);
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
    const target = this.activeMusicPanels.get(guildId);
    if (!target) {
      return false;
    }

    try {
      const channel = await this.channels.fetch(target.channelId);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) {
        this.activeMusicPanels.delete(guildId);
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
      await message.edit({
        content: null,
        components: panel.components,
        embeds: [],
        flags: panel.flags
      });
      return true;
    } catch (error) {
      this.logger.warn({ err: error, guildId }, "Impossible de rafraichir le panneau musique");
      this.activeMusicPanels.delete(guildId);
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
      await this.commandRegistry.publish();
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
        ephemeral: true
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
        ephemeral: true
      });
    }
  }

  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    if (!isMusicPanelAction(interaction.customId)) {
      return;
    }

    try {
      if (!interaction.guild) {
        await interaction.reply({
          content: "Ce bouton ne peut etre utilise que sur un serveur.",
          ephemeral: true
        });
        return;
      }
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({
          content: "Impossible de determiner le serveur pour ce panneau.",
          ephemeral: true
        });
        return;
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      const bypassDjCheck = interaction.customId === PANEL_BUTTONS.voteSkip;
      if (!bypassDjCheck && !this.accessPolicy.canManagePlayback(member)) {
        await interaction.reply({
          content: "Il faut un role DJ ou la permission Gerer le serveur.",
          ephemeral: true
        });
        return;
      }

      if (this.panelBusyMessages.has(interaction.message.id)) {
        await interaction.reply({
          content: "Une action est deja en cours sur ce panneau, reessaie dans une seconde.",
          ephemeral: true
        });
        return;
      }

      this.panelBusyMessages.add(interaction.message.id);
      await interaction.deferUpdate();
      const result = await this.musicService.handlePanelAction(interaction);
      this.registerMusicPanelMessage(guildId, interaction.channelId, interaction.message.id);
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
        await interaction.followUp({ content: `Erreur: ${message}`, ephemeral: true });
      } else {
        await interaction.reply({ content: `Erreur: ${message}`, ephemeral: true });
      }
    } finally {
      this.panelBusyMessages.delete(interaction.message.id);
    }
  }

  private async handleSelectInteraction(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!isMusicPanelSelectAction(interaction.customId)) {
      return;
    }

    try {
      if (!interaction.guild) {
        await interaction.reply({
          content: "Ce menu ne peut etre utilise que sur un serveur.",
          ephemeral: true
        });
        return;
      }

      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({
          content: "Impossible de determiner le serveur pour ce panneau.",
          ephemeral: true
        });
        return;
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!this.accessPolicy.canManagePlayback(member)) {
        await interaction.reply({
          content: "Il faut un role DJ ou la permission Gerer le serveur.",
          ephemeral: true
        });
        return;
      }

      if (this.panelBusyMessages.has(interaction.message.id)) {
        await interaction.reply({
          content: "Une action est deja en cours sur ce panneau, reessaie dans une seconde.",
          ephemeral: true
        });
        return;
      }

      this.panelBusyMessages.add(interaction.message.id);
      await interaction.deferUpdate();
      const result = await this.musicService.handlePanelSelectAction(interaction);
      this.registerMusicPanelMessage(guildId, interaction.channelId, interaction.message.id);
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
        await interaction.followUp({ content: `Erreur: ${message}`, ephemeral: true });
      } else {
        await interaction.reply({ content: `Erreur: ${message}`, ephemeral: true });
      }
    } finally {
      this.panelBusyMessages.delete(interaction.message.id);
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
      sourceName: "direct_url",
      modeInfo: modeLines.join("\n"),
      playlistInfo: playlistLines.join("\n"),
      queueHealthInfo: `Etat: Veille\nPistes en attente: ${queue.upcoming.length}\nTemps restant: 0:00\nErreurs recentes: non\nRecherche YouTube degradee: non`,
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
    if (this.activeMusicPanels.size === 0) {
      return;
    }

    for (const guildId of this.activeMusicPanels.keys()) {
      const player = this.musicService.getPlayer(guildId);
      if (!player?.playing) {
        continue;
      }

      await this.refreshRegisteredMusicPanel(guildId);
    }
  }
}
