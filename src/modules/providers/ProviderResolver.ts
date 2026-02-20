import type { ProviderMode, ProviderResolution } from "./types";

const SPOTIFY_REGEX = /(?:spotify\.com\/|spotify:)(?:track|playlist|album|artist)/i;
const APPLE_MUSIC_REGEX = /music\.apple\.com/i;
const DEEZER_REGEX = /(?:deezer\.com|deezer\.page\.link)/i;
const SOUNDCLOUD_REGEX = /soundcloud\.com/i;
const YOUTUBE_REGEX = /(?:youtube\.com|youtu\.be)/i;
const URL_REGEX = /^https?:\/\/\S+/i;
const PLAYLIST_HINT_REGEX = /(playlist|album|list=|sets\/)/i;

export class ProviderResolver {
  public resolve(input: string, preferredProvider: ProviderMode = "auto"): ProviderResolution {
    const query = input.trim();
    if (!query) {
      throw new Error("La recherche est vide.");
    }

    if (SPOTIFY_REGEX.test(query)) {
      return this.fromUrlProvider("spotify", query);
    }

    if (APPLE_MUSIC_REGEX.test(query)) {
      return this.fromUrlProvider("apple_music", query);
    }

    if (DEEZER_REGEX.test(query)) {
      return this.fromUrlProvider("deezer", query);
    }

    if (SOUNDCLOUD_REGEX.test(query)) {
      return this.fromUrlProvider("soundcloud", query);
    }

    if (YOUTUBE_REGEX.test(query)) {
      return this.fromUrlProvider("youtube", query);
    }

    if (URL_REGEX.test(query)) {
      return this.fromUrlProvider("direct_url", query);
    }

    if (preferredProvider !== "auto") {
      return this.fromProviderHint(query, preferredProvider);
    }

    return {
      provider: "youtube_music_search",
      searchQuery: {
        query,
        source: "ytmsearch"
      },
      isLikelyPlaylist: false
    };
  }

  private fromUrlProvider(provider: string, query: string): ProviderResolution {
    return {
      provider,
      searchQuery: {
        query
      },
      isLikelyPlaylist: PLAYLIST_HINT_REGEX.test(query)
    };
  }

  private fromProviderHint(query: string, preferredProvider: ProviderMode): ProviderResolution {
    switch (preferredProvider) {
      case "youtube":
        return {
          provider: "youtube_search",
          searchQuery: { query, source: "ytsearch" },
          isLikelyPlaylist: false
        };
      case "youtube_music":
        return {
          provider: "youtube_music_search",
          searchQuery: { query, source: "ytmsearch" },
          isLikelyPlaylist: false
        };
      case "soundcloud":
        return {
          provider: "soundcloud",
          searchQuery: { query, source: "scsearch" },
          isLikelyPlaylist: false
        };
      case "spotify":
        return {
          provider: "spotify",
          searchQuery: { query, source: "spsearch" },
          isLikelyPlaylist: false
        };
      case "apple_music":
        return {
          provider: "apple_music",
          searchQuery: { query, source: "amsearch" },
          isLikelyPlaylist: false
        };
      case "deezer":
        return {
          provider: "deezer",
          searchQuery: { query, source: "dzsearch" },
          isLikelyPlaylist: false
        };
      case "auto":
      default:
        return {
          provider: "youtube_music_search",
          searchQuery: { query, source: "ytmsearch" },
          isLikelyPlaylist: false
        };
    }
  }
}
