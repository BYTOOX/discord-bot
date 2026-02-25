import type { SearchQuery } from "lavalink-client";

export type ProviderName = "youtube" | "spotify" | "youtube_search";

export interface ProviderResolution {
  provider: ProviderName;
  searchQuery: SearchQuery;
  isLikelyPlaylist: boolean;
}

