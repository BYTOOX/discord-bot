import type { ProviderResolution } from "./types";

const SPOTIFY_REGEX = /(?:spotify\.com\/(?:intl-[a-z]{2}\/)?|spotify:)(?:track|playlist|album|artist)/i;
const YOUTUBE_REGEX = /(?:youtube\.com|youtu\.be)/i;
const URL_REGEX = /^https?:\/\/\S+/i;
const PLAYLIST_HINT_REGEX = /(playlist|album|list=)/i;

export class ProviderResolver {
  public resolve(input: string): ProviderResolution {
    const query = input.trim();
    if (!query) {
      throw new Error("La recherche est vide.");
    }

    if (SPOTIFY_REGEX.test(query)) {
      return {
        provider: "spotify",
        searchQuery: { query },
        isLikelyPlaylist: PLAYLIST_HINT_REGEX.test(query)
      };
    }

    if (YOUTUBE_REGEX.test(query)) {
      return {
        provider: "youtube",
        searchQuery: { query },
        isLikelyPlaylist: PLAYLIST_HINT_REGEX.test(query)
      };
    }

    if (URL_REGEX.test(query)) {
      throw new Error(
        "Source non supportee. Le bot accepte uniquement YouTube et Spotify."
      );
    }

    return {
      provider: "youtube_search",
      searchQuery: {
        query,
        source: "ytsearch"
      },
      isLikelyPlaylist: false
    };
  }
}

