import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  type ButtonInteraction,
  type Interaction
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
import {
  buildPanelComponents,
  disablePanelRows,
  isMusicPanelAction,
  withPanelStatus
} from "../modules/music/MusicPanel";

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

    this.eventHandlersBound = true;
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      await this.handleButtonInteraction(interaction);
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
      const result = await this.musicService.handlePanelAction(interaction);

      if (result.disablePanel) {
        if (interaction.message.components.length > 0) {
          const rows = interaction.message.components
            .map((row) => row.toJSON())
            .filter((component) => component.type === 1 && "components" in component)
            .map((component) => ({
              components: (component as { components: unknown[] }).components
            }));

          await interaction.message.edit({
            components: disablePanelRows(rows),
            embeds: withPanelStatus(interaction.message.embeds, result.message)
          });
        }
      } else if (result.state) {
        await interaction.message.edit({
          components: buildPanelComponents(result.state),
          embeds: withPanelStatus(interaction.message.embeds, result.message)
        });
      }
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
}
