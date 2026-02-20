import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  LAVALINK_HOST: z.string().default("localhost"),
  LAVALINK_PORT: z.coerce.number().int().positive().default(2333),
  LAVALINK_PASSWORD: z.string().default("youshallnotpass"),
  LAVALINK_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DEFAULT_VOLUME: z.coerce.number().int().min(1).max(200).default(80),
  PLAYER_EMPTY_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(300_000),
  PLAYER_SELF_DEAF: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MUSIC_PANEL_EMOJI: z.string().default("\u{1F4BF}"),
  AUTOPLAY_DEFAULT: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  STAY_IN_VOICE_DEFAULT: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DJ_ROLE_IDS: z.string().default(""),
  MAX_CUSTOM_PLAYLISTS: z.coerce.number().int().min(1).default(50),
  MAX_TRACKS_PER_PLAYLIST: z.coerce.number().int().min(1).default(500),
  PLAYLIST_STORE_PATH: z.string().default("data/custom-playlists.json"),
  GUILD_SETTINGS_STORE_PATH: z.string().default("data/guild-settings.json")
});

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  lavalinkHost: string;
  lavalinkPort: number;
  lavalinkPassword: string;
  lavalinkSecure: boolean;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  defaultVolume: number;
  playerEmptyTimeoutMs: number;
  playerSelfDeaf: boolean;
  musicPanelEmoji: string;
  autoplayDefault: boolean;
  stayInVoiceDefault: boolean;
  djRoleIds: string[];
  maxCustomPlaylists: number;
  maxTracksPerPlaylist: number;
  playlistStorePath: string;
  guildSettingsStorePath: string;
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  const djRoleIds = parsed.DJ_ROLE_IDS.split(",")
    .map((roleId) => roleId.trim())
    .filter((roleId) => roleId.length > 0);

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID,
    lavalinkHost: parsed.LAVALINK_HOST,
    lavalinkPort: parsed.LAVALINK_PORT,
    lavalinkPassword: parsed.LAVALINK_PASSWORD,
    lavalinkSecure: parsed.LAVALINK_SECURE,
    logLevel: parsed.LOG_LEVEL,
    defaultVolume: parsed.DEFAULT_VOLUME,
    playerEmptyTimeoutMs: parsed.PLAYER_EMPTY_TIMEOUT_MS,
    playerSelfDeaf: parsed.PLAYER_SELF_DEAF,
    musicPanelEmoji: parsed.MUSIC_PANEL_EMOJI,
    autoplayDefault: parsed.AUTOPLAY_DEFAULT,
    stayInVoiceDefault: parsed.STAY_IN_VOICE_DEFAULT,
    djRoleIds,
    maxCustomPlaylists: parsed.MAX_CUSTOM_PLAYLISTS,
    maxTracksPerPlaylist: parsed.MAX_TRACKS_PER_PLAYLIST,
    playlistStorePath: parsed.PLAYLIST_STORE_PATH,
    guildSettingsStorePath: parsed.GUILD_SETTINGS_STORE_PATH
  };
}

