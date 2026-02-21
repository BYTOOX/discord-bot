import type { Track, UnresolvedTrack } from "lavalink-client";

export interface GuildPlaybackSettings {
  autoplay: boolean;
  stayInVoice: boolean;
  volume: number;
}

export interface EnqueueResult {
  provider: string;
  addedCount: number;
  duplicateSkippedCount: number;
  isPlaylist: boolean;
  playlistName?: string;
  firstTrackTitle: string;
  firstTrackAuthor?: string;
  firstTrackDurationMs?: number;
  firstTrackUrl?: string;
  firstTrackArtworkUrl?: string;
}

export interface MusicPanelDisplay {
  trackTitle: string;
  trackAuthor: string;
  trackDurationMs: number;
  trackPositionMs: number;
  isPlaying: boolean;
  isPaused: boolean;
  accentColor?: number;
  trackUrl?: string;
  trackArtworkUrl?: string;
  sourceName: string;
  requestedById?: string;
  modeInfo: string;
  playlistInfo: string;
  queueHealthInfo: string;
  sessionInfo: string;
  voteSkipInfo: string;
  jumpTargets: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
}

export type QueueTrack = Track | UnresolvedTrack;
