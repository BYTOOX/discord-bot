import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "pino";

import type { GuildPlaybackSettings } from "./types";

interface GuildSettingsFile {
  byGuild: Record<string, GuildPlaybackSettings>;
}

interface GuildSettingsDefaults {
  autoplay: boolean;
  stayInVoice: boolean;
  volume: number;
}

export class GuildSettingsService {
  private readonly cache = new Map<string, GuildPlaybackSettings>();
  private loaded = false;

  public constructor(
    private readonly storePath: string,
    private readonly defaults: GuildSettingsDefaults,
    private readonly logger: Logger
  ) {}

  public async get(guildId: string): Promise<GuildPlaybackSettings> {
    await this.ensureLoaded();

    const cached = this.cache.get(guildId);
    if (cached) {
      return cached;
    }

    const settings: GuildPlaybackSettings = {
      autoplay: this.defaults.autoplay,
      stayInVoice: this.defaults.stayInVoice,
      volume: this.defaults.volume
    };
    this.cache.set(guildId, settings);
    await this.persist();
    return settings;
  }

  public async setAutoplay(guildId: string, enabled: boolean): Promise<GuildPlaybackSettings> {
    const settings = await this.get(guildId);
    settings.autoplay = enabled;
    await this.persist();
    return settings;
  }

  public async setStayInVoice(guildId: string, enabled: boolean): Promise<GuildPlaybackSettings> {
    const settings = await this.get(guildId);
    settings.stayInVoice = enabled;
    await this.persist();
    return settings;
  }

  public async setVolume(guildId: string, volume: number): Promise<GuildPlaybackSettings> {
    const settings = await this.get(guildId);
    settings.volume = volume;
    await this.persist();
    return settings;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as GuildSettingsFile;
      for (const [guildId, settings] of Object.entries(parsed.byGuild ?? {})) {
        this.cache.set(guildId, settings);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn({ err: error }, "Failed to load guild settings store");
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const byGuild = Object.fromEntries(this.cache.entries());
    const payload: GuildSettingsFile = { byGuild };
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(payload, null, 2), "utf8");
  }
}

