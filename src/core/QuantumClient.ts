import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction
} from "discord.js";
import type { Logger } from "pino";

import type { AppConfig } from "../config/env";
import { PostgresService } from "../modules/infrastructure/PostgresService";
import { RedisLockService } from "../modules/infrastructure/RedisLockService";
import { GuildSettingsService } from "../modules/music/GuildSettingsService";
import { LavalinkService } from "../modules/music/LavalinkService";
import { MusicControlSurfaceService } from "../modules/music/MusicControlSurfaceService";
import { MusicService } from "../modules/music/MusicService";
import { AccessPolicyService } from "../modules/policies/AccessPolicyService";
import { ProviderResolver } from "../modules/providers/ProviderResolver";
import { CommandRegistry } from "./CommandRegistry";
import { sendReply } from "./interactionReply";
import type { SlashCommand } from "./types";

const INTERACTION_LOCK_TTL_MS = 20_000;
const COMMAND_PUBLISH_LOCK_TTL_MS = 90_000;

export interface QuantumClientRuntimeOptions {
  role?: "default" | "orchestrator" | "jukebox";
  enableInteractions?: boolean;
  enableCommandPublishing?: boolean;
  enablePlaybackRuntime?: boolean;
  enablePanelSystem?: boolean;
}

export class QuantumClient extends Client {
  public readonly config: AppConfig;
  public readonly logger: Logger;
  public readonly commands = new Collection<string, SlashCommand>();
  public readonly postgresService: PostgresService;
  public readonly redisLockService: RedisLockService;
  public readonly commandRegistry: CommandRegistry;
  public readonly accessPolicy: AccessPolicyService;
  public readonly guildSettingsService: GuildSettingsService;
  public readonly providerResolver: ProviderResolver;
  public readonly lavalinkService: LavalinkService;
  public readonly musicService: MusicService;
  public readonly musicControlSurface: MusicControlSurfaceService;
  public readonly runtimeOptions: Required<QuantumClientRuntimeOptions>;
  private eventHandlersBound = false;
  private commandExecutionClient: QuantumClient = this;

  public constructor(config: AppConfig, logger: Logger, options: QuantumClientRuntimeOptions = {}) {
    super({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
    });

    this.runtimeOptions = {
      role: options.role ?? "default",
      enableInteractions: options.enableInteractions ?? true,
      enableCommandPublishing: options.enableCommandPublishing ?? true,
      enablePlaybackRuntime: options.enablePlaybackRuntime ?? true,
      enablePanelSystem: options.enablePanelSystem ?? true
    };

    this.config = config;
    this.logger = logger;
    this.postgresService = new PostgresService(config.postgresUrl, logger.child({ scope: "postgres" }));
    this.redisLockService = new RedisLockService(config.redisUrl, logger.child({ scope: "redis" }));
    this.commandRegistry = new CommandRegistry(config, logger.child({ scope: "commands" }));
    this.accessPolicy = new AccessPolicyService(config);
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
    this.lavalinkService = new LavalinkService(this, config, logger.child({ scope: "lavalink" }));
    this.musicService = new MusicService(
      this.lavalinkService,
      this.providerResolver,
      this.guildSettingsService,
      config.playerEmptyTimeoutMs,
      config.playerSelfDeaf,
      logger.child({ scope: "music" })
    );
    this.musicControlSurface = new MusicControlSurfaceService(
      this,
      logger.child({ scope: "music-control-surface" })
    );
  }

  public setCommandExecutionClient(client: QuantumClient): void {
    this.commandExecutionClient = client;
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

  public async refreshRegisteredMusicPanel(guildId: string, status?: string): Promise<boolean> {
    return this.musicControlSurface.refreshGuild(guildId, status);
  }

  public async forceRebuildMusicControlSurface(guildId: string): Promise<boolean> {
    return this.musicControlSurface.forceRebuild(guildId);
  }

  public async cleanMusicControlSurface(guildId: string): Promise<boolean> {
    return this.musicControlSurface.cleanNow(guildId);
  }

  private bindEvents(): void {
    if (this.eventHandlersBound) {
      return;
    }

    this.once(Events.ClientReady, async (readyClient) => {
      this.logger.info(
        {
          username: readyClient.user.tag,
          guildCount: readyClient.guilds.cache.size,
          role: this.runtimeOptions.role
        },
        "Client Discord pret"
      );

      if (this.runtimeOptions.role === "jukebox") {
        readyClient.user.setPresence({ status: "invisible" });
      }

      if (this.runtimeOptions.enablePlaybackRuntime) {
        await this.musicService.initialize(readyClient.user.id, readyClient.user.username);
      }

      if (!this.runtimeOptions.enableCommandPublishing) {
        if (this.runtimeOptions.role !== "jukebox") {
          await this.initializeControlSurfaceSafely();
        }
        return;
      }

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

      if (this.runtimeOptions.role !== "jukebox") {
        await this.initializeControlSurfaceSafely();
      }
    });

    if (this.runtimeOptions.enablePlaybackRuntime) {
      this.on(Events.Raw, (payload) => {
        void this.musicService.forwardRawEvent(payload);
      });
    }

    if (this.runtimeOptions.enableInteractions) {
      this.on(Events.InteractionCreate, (interaction: Interaction) => {
        void this.handleInteraction(interaction);
      });
    }

    this.on(Events.Warn, (warning) => {
      this.logger.warn({ warning }, "Avertissement client Discord");
    });

    this.on(Events.Error, (error) => {
      this.logger.error({ err: error }, "Erreur client Discord");
    });

    if (this.runtimeOptions.enablePlaybackRuntime && this.runtimeOptions.role !== "jukebox") {
      this.lavalinkService.manager.on("trackStart", (player) => {
        void this.refreshRegisteredMusicPanel(player.guildId, "Lecture mise a jour.");
      });

      this.lavalinkService.manager.on("queueEnd", (player) => {
        void this.refreshRegisteredMusicPanel(player.guildId, "File terminee.");
      });

      this.lavalinkService.manager.on("playerDestroy", (player) => {
        void this.refreshRegisteredMusicPanel(player.guildId, "Player deconnecte.");
      });
    }

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
        await this.musicControlSurface.handleButtonInteraction(interaction);
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
        await command.execute(interaction, this.commandExecutionClient);
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

  private async initializeControlSurfaceSafely(): Promise<void> {
    try {
      await this.musicControlSurface.initializeForGuild(this.config.discordGuildId);
    } catch (error) {
      this.logger.error({ err: error }, "Echec initialisation command center");
    }
  }
}
