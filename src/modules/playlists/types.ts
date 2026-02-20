export interface PlaylistTrackInput {
  query: string;
  title: string;
  url?: string;
  addedBy: string;
}

export interface StoredPlaylistTrack extends PlaylistTrackInput {
  addedAt: string;
}

export interface CustomPlaylist {
  id: string;
  guildId: string;
  name: string;
  key: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  tracks: StoredPlaylistTrack[];
}

