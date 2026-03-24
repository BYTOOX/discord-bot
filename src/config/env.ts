import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  JUKEBOX_TOKENS: z.string().default(""),
  JUKEBOX_FIXED_NAMES: z.string().default(""),
  POSTGRES_URL: z
    .string()
    .url()
    .default("postgresql://quantum:quantum@postgres:5432/quantum_jukebox"),
  REDIS_URL: z.string().url().default("redis://redis:6379"),
  LAVALINK_HOST: z.string().default("lavalink"),
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
    .default("true")
    .transform((value) => value === "true"),
  MUSIC_PANEL_EMOJI: z.string().default("\u{1F4BF}"),
  MUSIC_CONTROL_CHANNEL_ID: z.string().default(""),
  AUTOPLAY_DEFAULT: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  STAY_IN_VOICE_DEFAULT: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DJ_ROLE_IDS: z.string().default(""),
  COMMAND_CENTER_ROLE_IDS: z.string().default(""),
  SPOTIFY_CLIENT_ID: z.string().default(""),
  SPOTIFY_CLIENT_SECRET: z.string().default("")
});

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  jukeboxTokens: string[];
  jukeboxFixedNames: string[];
  postgresUrl: string;
  redisUrl: string;
  lavalinkHost: string;
  lavalinkPort: number;
  lavalinkPassword: string;
  lavalinkSecure: boolean;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  defaultVolume: number;
  playerEmptyTimeoutMs: number;
  playerSelfDeaf: boolean;
  musicPanelEmoji: string;
  musicControlChannelId: string | null;
  autoplayDefault: boolean;
  stayInVoiceDefault: boolean;
  djRoleIds: string[];
  commandCenterRoleIds: string[];
  spotifyClientId: string | null;
  spotifyClientSecret: string | null;
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  const djRoleIds = parsed.DJ_ROLE_IDS.split(",")
    .map((roleId) => roleId.trim())
    .filter((roleId) => roleId.length > 0);

  const commandCenterRoleIds = parsed.COMMAND_CENTER_ROLE_IDS.split(",")
    .map((roleId) => roleId.trim())
    .filter((roleId) => roleId.length > 0);

  const jukeboxTokens = parsed.JUKEBOX_TOKENS.split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (jukeboxTokens.length > 0 && jukeboxTokens.length < 3) {
    throw new Error(
      "Configuration invalide: JUKEBOX_TOKENS doit contenir au moins 3 tokens ou rester vide."
    );
  }

  const jukeboxFixedNames = parsed.JUKEBOX_FIXED_NAMES.split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  return {
    discordToken: parsed.DISCORD_TOKEN,
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordGuildId: parsed.DISCORD_GUILD_ID,
    jukeboxTokens,
    jukeboxFixedNames,
    postgresUrl: parsed.POSTGRES_URL,
    redisUrl: parsed.REDIS_URL,
    lavalinkHost: parsed.LAVALINK_HOST,
    lavalinkPort: parsed.LAVALINK_PORT,
    lavalinkPassword: parsed.LAVALINK_PASSWORD,
    lavalinkSecure: parsed.LAVALINK_SECURE,
    logLevel: parsed.LOG_LEVEL,
    defaultVolume: parsed.DEFAULT_VOLUME,
    playerEmptyTimeoutMs: parsed.PLAYER_EMPTY_TIMEOUT_MS,
    playerSelfDeaf: parsed.PLAYER_SELF_DEAF,
    musicPanelEmoji: parsed.MUSIC_PANEL_EMOJI,
    musicControlChannelId:
      parsed.MUSIC_CONTROL_CHANNEL_ID.trim().length > 0
        ? parsed.MUSIC_CONTROL_CHANNEL_ID.trim()
        : null,
    autoplayDefault: parsed.AUTOPLAY_DEFAULT,
    stayInVoiceDefault: parsed.STAY_IN_VOICE_DEFAULT,
    djRoleIds,
    commandCenterRoleIds,
    spotifyClientId: parsed.SPOTIFY_CLIENT_ID.trim().length > 0 ? parsed.SPOTIFY_CLIENT_ID.trim() : null,
    spotifyClientSecret:
      parsed.SPOTIFY_CLIENT_SECRET.trim().length > 0
        ? parsed.SPOTIFY_CLIENT_SECRET.trim()
        : null
  };
}


