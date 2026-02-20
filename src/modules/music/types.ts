import type { Track, UnresolvedTrack } from "lavalink-client";

export interface GuildPlaybackSettings {
  autoplay: boolean;
  stayInVoice: boolean;
  volume: number;
}

export interface EnqueueResult {
  provider: string;
  addedCount: number;
  isPlaylist: boolean;
  playlistName?: string;
  firstTrackTitle: string;
  firstTrackAuthor?: string;
  firstTrackDurationMs?: number;
  firstTrackUrl?: string;
  firstTrackArtworkUrl?: string;
}

export type QueueTrack = Track | UnresolvedTrack;
