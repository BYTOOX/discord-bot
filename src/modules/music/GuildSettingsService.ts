import type { Logger } from "pino";

import { PostgresService } from "../infrastructure/PostgresService";
import type { GuildPlaybackSettings } from "./types";

interface GuildSettingsDefaults {
  autoplay: boolean;
  stayInVoice: boolean;
  volume: number;
}

interface GuildSettingsRow {
  autoplay: boolean;
  stay_in_voice: boolean;
  volume: number;
}

export class GuildSettingsService {
  public constructor(
    private readonly postgres: PostgresService,
    private readonly defaults: GuildSettingsDefaults,
    private readonly logger: Logger
  ) {}

  public async get(guildId: string): Promise<GuildPlaybackSettings> {
    await this.ensureDefaults(guildId);

    const result = await this.postgres.query<GuildSettingsRow>(
      `
      SELECT autoplay, stay_in_voice, volume
      FROM guild_settings
      WHERE guild_id = $1
      `,
      [guildId]
    );

    const row = result.rows[0];
    if (!row) {
      this.logger.warn({ guildId }, "Parametres guild manquants apres initialisation");
      return { ...this.defaults };
    }

    return this.toSettings(row);
  }

  public async setAutoplay(guildId: string, enabled: boolean): Promise<GuildPlaybackSettings> {
    const result = await this.postgres.query<GuildSettingsRow>(
      `
      UPDATE guild_settings
      SET autoplay = $2, updated_at = NOW()
      WHERE guild_id = $1
      RETURNING autoplay, stay_in_voice, volume
      `,
      [guildId, enabled]
    );

    const row = result.rows[0];
    if (!row) {
      await this.ensureDefaults(guildId);
      return this.setAutoplay(guildId, enabled);
    }

    return this.toSettings(row);
  }

  public async setStayInVoice(guildId: string, enabled: boolean): Promise<GuildPlaybackSettings> {
    const result = await this.postgres.query<GuildSettingsRow>(
      `
      UPDATE guild_settings
      SET stay_in_voice = $2, updated_at = NOW()
      WHERE guild_id = $1
      RETURNING autoplay, stay_in_voice, volume
      `,
      [guildId, enabled]
    );

    const row = result.rows[0];
    if (!row) {
      await this.ensureDefaults(guildId);
      return this.setStayInVoice(guildId, enabled);
    }

    return this.toSettings(row);
  }

  public async setVolume(guildId: string, volume: number): Promise<GuildPlaybackSettings> {
    const result = await this.postgres.query<GuildSettingsRow>(
      `
      UPDATE guild_settings
      SET volume = $2, updated_at = NOW()
      WHERE guild_id = $1
      RETURNING autoplay, stay_in_voice, volume
      `,
      [guildId, volume]
    );

    const row = result.rows[0];
    if (!row) {
      await this.ensureDefaults(guildId);
      return this.setVolume(guildId, volume);
    }

    return this.toSettings(row);
  }

  private async ensureDefaults(guildId: string): Promise<void> {
    await this.postgres.query(
      `
      INSERT INTO guild_settings (guild_id, autoplay, stay_in_voice, volume, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (guild_id)
      DO NOTHING
      `,
      [guildId, this.defaults.autoplay, this.defaults.stayInVoice, this.defaults.volume]
    );
  }

  private toSettings(row: GuildSettingsRow): GuildPlaybackSettings {
    return {
      autoplay: row.autoplay,
      stayInVoice: row.stay_in_voice,
      volume: row.volume
    };
  }
}

