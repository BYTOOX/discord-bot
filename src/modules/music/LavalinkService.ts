import type { Client } from "discord.js";
import { LavalinkManager, type SearchQuery } from "lavalink-client";
import type { Logger } from "pino";

import type { AppConfig } from "../../config/env";

export interface LavalinkRawTrack {
  encoded: string;
  info: {
    identifier?: string;
    isSeekable?: boolean;
    author?: string;
    length?: number;
    isStream?: boolean;
    position?: number;
    title?: string;
    uri?: string;
    artworkUrl?: string;
    sourceName?: string;
  };
  pluginInfo?: Record<string, unknown>;
  userData?: Record<string, unknown>;
}

export type LavalinkLoadResult =
  | { loadType: "empty"; data: Record<string, never> }
  | { loadType: "track"; data: LavalinkRawTrack }
  | { loadType: "search"; data: LavalinkRawTrack[] }
  | {
      loadType: "playlist";
      data: {
        info: { name?: string; selectedTrack?: number };
        tracks: LavalinkRawTrack[];
      };
    }
  | {
      loadType: "error";
      data: { message?: string; severity?: string; cause?: string };
    };

export class LavalinkService {
  public readonly manager: LavalinkManager;
  private initialized = false;
  private readonly baseHttpUrl: string;

  public constructor(
    private readonly client: Client,
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.baseHttpUrl = `${config.lavalinkSecure ? "https" : "http"}://${config.lavalinkHost}:${config.lavalinkPort}`;

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
        defaultSearchPlatform: "ytsearch",
        maxErrorsPerTime: {
          threshold: 120_000,
          maxAmount: 12
        },
        onDisconnect: {
          destroyPlayer: false,
          autoReconnect: true,
          autoReconnectOnlyWithTracks: false
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
    this.logger.info("Gestionnaire Lavalink initialise");
  }

  public async forwardRawEvent(payload: unknown): Promise<void> {
    await this.manager.sendRawData(payload as never);
  }

  public async loadTracks(searchQuery: SearchQuery): Promise<LavalinkLoadResult> {
    const identifier = this.toIdentifier(searchQuery);
    if (identifier.length === 0) {
      throw new Error("Requete Lavalink vide.");
    }

    const response = await fetch(
      `${this.baseHttpUrl}/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`,
      {
        method: "GET",
        headers: {
          Authorization: this.config.lavalinkPassword
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Lavalink indisponible (${response.status}).`);
    }

    const payload = (await response.json()) as LavalinkLoadResult;
    return payload;
  }

  private toIdentifier(searchQuery: SearchQuery): string {
    if (typeof searchQuery === "string") {
      return searchQuery.trim();
    }

    const query = `${searchQuery.query ?? ""}`.trim();
    const source =
      typeof (searchQuery as { source?: unknown }).source === "string"
        ? ((searchQuery as { source: string }).source ?? "").trim()
        : "";

    if (!query || !source || /^https?:\/\//i.test(query)) {
      return query;
    }

    return `${source}:${query}`;
  }

  private bindManagerEvents(): void {
    this.manager.nodeManager.on("connect", (node) => {
      this.logger.info(
        { nodeId: node.options.id, host: node.options.host },
        "Noeud Lavalink connecte"
      );
    });

    this.manager.nodeManager.on("disconnect", (node, reason) => {
      this.logger.warn(
        { nodeId: node.options.id, host: node.options.host, reason },
        "Noeud Lavalink deconnecte"
      );
    });

    this.manager.nodeManager.on("reconnecting", (node) => {
      this.logger.warn(
        { nodeId: node.options.id, host: node.options.host },
        "Noeud Lavalink en reconnexion"
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
        "Erreur noeud Lavalink"
      );
    });

    this.manager.on("trackStart", (player, track) => {
      if (!track) {
        return;
      }
      this.logger.info(
        { guildId: player.guildId, title: track.info.title, author: track.info.author },
        "Piste demarree"
      );
    });

    this.manager.on("trackError", (player, track, payload) => {
      this.logger.error(
        {
          guildId: player.guildId,
          title: track?.info.title,
          message: payload.exception?.message
        },
        "Erreur de piste"
      );
    });

    this.manager.on("trackEnd", (player, track, payload) => {
      this.logger.info(
        {
          guildId: player.guildId,
          title: track?.info.title,
          reason: payload.reason
        },
        "Piste terminee"
      );
    });
  }
}

