import type { SearchQuery } from "lavalink-client";

export type ProviderMode =
  | "auto"
  | "youtube"
  | "youtube_music"
  | "soundcloud"
  | "spotify"
  | "apple_music"
  | "deezer";

export interface ProviderResolution {
  provider: string;
  searchQuery: SearchQuery;
  isLikelyPlaylist: boolean;
}
