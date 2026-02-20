import type { Client } from "discord.js";
import { LavalinkManager } from "lavalink-client";
import type { Logger } from "pino";

import type { AppConfig } from "../../config/env";

export class LavalinkService {
  public readonly manager: LavalinkManager;
  private initialized = false;

  public constructor(
    private readonly client: Client,
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.manager = new LavalinkManager({
      nodes: [
        {
          id: "main",
          host: config.lavalinkHost,
          port: config.lavalinkPort,
          authorization: config.lavalinkPassword,
          secure: config.lavalinkSecure
        }
      ],
      sendToShard: (guildId, payload) => {
        const guild = this.client.guilds.cache.get(guildId);
        guild?.shard?.send(payload);
      },
      autoSkip: true,
      autoMove: true,
      playerOptions: {
        defaultSearchPlatform: "ytmsearch",
        onDisconnect: {
          autoReconnect: true,
          autoReconnectOnlyWithTracks: true
        }
      }
    });

    this.bindManagerEvents();
  }

  public async initialize(clientId: string, username: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.manager.init({ id: clientId, username });
    this.initialized = true;
    this.logger.info("Lavalink manager initialized");
  }

  public async forwardRawEvent(payload: unknown): Promise<void> {
    await this.manager.sendRawData(payload as never);
  }

  private bindManagerEvents(): void {
    this.manager.nodeManager.on("connect", (node) => {
      this.logger.info({ nodeId: node.options.id, host: node.options.host }, "Lavalink node connected");
    });

    this.manager.nodeManager.on("disconnect", (node, reason) => {
      this.logger.warn(
        { nodeId: node.options.id, host: node.options.host, reason },
        "Lavalink node disconnected"
      );
    });

    this.manager.nodeManager.on("reconnecting", (node) => {
      this.logger.warn(
        { nodeId: node.options.id, host: node.options.host },
        "Lavalink node reconnecting"
      );
    });

    this.manager.nodeManager.on("error", (node, error, payload) => {
      this.logger.error(
        {
          nodeId: node.options.id,
          host: node.options.host,
          err: error,
          payload
        },
        "Lavalink node error"
      );
    });

    this.manager.on("trackStart", (player, track) => {
      if (!track) {
        return;
      }
      this.logger.info(
        { guildId: player.guildId, title: track.info.title, author: track.info.author },
        "Track started"
      );
    });

    this.manager.on("trackError", (player, track, payload) => {
      this.logger.error(
        {
          guildId: player.guildId,
          title: track?.info.title,
          message: payload.exception?.message
        },
        "Track error"
      );
    });
  }
}
