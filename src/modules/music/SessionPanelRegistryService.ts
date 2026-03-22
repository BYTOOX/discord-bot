import type { Logger } from "pino";

import { PostgresService } from "../infrastructure/PostgresService";

export interface RegisteredSessionPanel {
  guildId: string;
  slotId: string;
  channelId: string;
  messageId: string;
}

interface SessionPanelRow {
  guild_id: string;
  slot_id: string;
  channel_id: string;
  message_id: string;
}

export class SessionPanelRegistryService {
  public constructor(
    private readonly postgres: PostgresService,
    private readonly logger: Logger
  ) {}

  public async set(
    guildId: string,
    slotId: string,
    channelId: string,
    messageId: string
  ): Promise<void> {
    await this.postgres.query(
      `
      INSERT INTO music_session_panels (guild_id, slot_id, channel_id, message_id, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (guild_id, slot_id)
      DO UPDATE SET
        channel_id = EXCLUDED.channel_id,
        message_id = EXCLUDED.message_id,
        updated_at = NOW()
      `,
      [guildId, slotId, channelId, messageId]
    );
  }

  public async get(guildId: string, slotId: string): Promise<RegisteredSessionPanel | null> {
    const result = await this.postgres.query<SessionPanelRow>(
      `
      SELECT guild_id, slot_id, channel_id, message_id
      FROM music_session_panels
      WHERE guild_id = $1 AND slot_id = $2
      `,
      [guildId, slotId]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      guildId: row.guild_id,
      slotId: row.slot_id,
      channelId: row.channel_id,
      messageId: row.message_id
    };
  }

  public async clear(guildId: string, slotId: string): Promise<boolean> {
    const result = await this.postgres.query(
      `
      DELETE FROM music_session_panels
      WHERE guild_id = $1 AND slot_id = $2
      `,
      [guildId, slotId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  public reportInvalid(
    guildId: string,
    slotId: string,
    channelId: string,
    messageId: string
  ): void {
    this.logger.warn({ guildId, slotId, channelId, messageId }, "Panneau de session invalide detecte");
  }
}
