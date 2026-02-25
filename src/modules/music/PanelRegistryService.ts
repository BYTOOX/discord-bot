import type { Logger } from "pino";

import { PostgresService } from "../infrastructure/PostgresService";

export interface RegisteredPanel {
  guildId: string;
  channelId: string;
  messageId: string;
}

interface PanelRow {
  guild_id: string;
  channel_id: string;
  message_id: string;
}

export class PanelRegistryService {
  public constructor(
    private readonly postgres: PostgresService,
    private readonly logger: Logger
  ) {}

  public async set(guildId: string, channelId: string, messageId: string): Promise<void> {
    await this.postgres.query(
      `
      INSERT INTO music_panels (guild_id, channel_id, message_id, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (guild_id)
      DO UPDATE SET
        channel_id = EXCLUDED.channel_id,
        message_id = EXCLUDED.message_id,
        updated_at = NOW()
      `,
      [guildId, channelId, messageId]
    );
  }

  public async get(guildId: string): Promise<RegisteredPanel | null> {
    const result = await this.postgres.query<PanelRow>(
      `
      SELECT guild_id, channel_id, message_id
      FROM music_panels
      WHERE guild_id = $1
      `,
      [guildId]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      guildId: row.guild_id,
      channelId: row.channel_id,
      messageId: row.message_id
    };
  }

  public async clear(guildId: string): Promise<boolean> {
    const result = await this.postgres.query(
      `
      DELETE FROM music_panels
      WHERE guild_id = $1
      `,
      [guildId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  public async listGuildIds(): Promise<string[]> {
    const result = await this.postgres.query<{ guild_id: string }>(
      `
      SELECT guild_id
      FROM music_panels
      ORDER BY updated_at DESC
      `
    );

    return result.rows.map((row) => row.guild_id);
  }

  public reportInvalid(guildId: string, channelId: string, messageId: string): void {
    this.logger.warn({ guildId, channelId, messageId }, "Panel invalide detecte");
  }
}

