import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import type { Logger } from "pino";

import { PostgresService } from "../infrastructure/PostgresService";
import type { CustomPlaylist, PlaylistTrackInput, StoredPlaylistTrack } from "./types";

interface PlaylistLimits {
  maxPlaylists: number;
  maxTracksPerPlaylist: number;
}

interface PlaylistRow {
  id: string;
  guild_id: string;
  name: string;
  key: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface PlaylistTrackRow {
  playlist_id: string;
  position: number;
  query: string;
  title: string;
  url: string | null;
  added_by: string;
  added_at: Date;
}

export class CustomPlaylistService {
  public constructor(
    private readonly postgres: PostgresService,
    private readonly limits: PlaylistLimits,
    private readonly logger: Logger
  ) {}

  public async createPlaylist(
    guildId: string,
    name: string,
    createdBy: string
  ): Promise<CustomPlaylist> {
    const normalizedName = normalizePlaylistName(name);
    const key = this.getKey(guildId, normalizedName);

    const existing = await this.getPlaylist(guildId, normalizedName);
    if (existing) {
      throw new Error(`La playlist "${normalizedName}" existe deja.`);
    }

    const countResult = await this.postgres.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM custom_playlists
      WHERE guild_id = $1
      `,
      [guildId]
    );

    const count = Number.parseInt(countResult.rows[0]?.count ?? "0", 10);
    if (count >= this.limits.maxPlaylists) {
      throw new Error(`Limite de playlists atteinte (${this.limits.maxPlaylists}).`);
    }

    const now = new Date();
    const id = randomUUID();

    await this.postgres.query(
      `
      INSERT INTO custom_playlists (id, guild_id, name, key, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      `,
      [id, guildId, normalizedName, key, createdBy, now]
    );

    const playlist = await this.getPlaylist(guildId, normalizedName);
    if (!playlist) {
      throw new Error("Playlist creee mais introuvable ensuite.");
    }

    return playlist;
  }

  public async listPlaylists(guildId: string): Promise<CustomPlaylist[]> {
    const playlists = await this.postgres.query<PlaylistRow>(
      `
      SELECT id, guild_id, name, key, created_by, created_at, updated_at
      FROM custom_playlists
      WHERE guild_id = $1
      ORDER BY name ASC
      `,
      [guildId]
    );

    if (playlists.rows.length === 0) {
      return [];
    }

    const ids = playlists.rows.map((row) => row.id);
    const tracks = await this.postgres.query<PlaylistTrackRow>(
      `
      SELECT playlist_id, position, query, title, url, added_by, added_at
      FROM playlist_tracks
      WHERE playlist_id = ANY($1::uuid[])
      ORDER BY playlist_id, position ASC
      `,
      [ids]
    );

    const tracksByPlaylist = new Map<string, StoredPlaylistTrack[]>();
    for (const trackRow of tracks.rows) {
      const list = tracksByPlaylist.get(trackRow.playlist_id) ?? [];
      list.push(this.toStoredTrack(trackRow));
      tracksByPlaylist.set(trackRow.playlist_id, list);
    }

    return playlists.rows.map((row) => this.toPlaylist(row, tracksByPlaylist.get(row.id) ?? []));
  }

  public async getPlaylist(guildId: string, name: string): Promise<CustomPlaylist | null> {
    const normalizedName = normalizePlaylistName(name);
    const key = this.getKey(guildId, normalizedName);

    const playlistResult = await this.postgres.query<PlaylistRow>(
      `
      SELECT id, guild_id, name, key, created_by, created_at, updated_at
      FROM custom_playlists
      WHERE key = $1
      LIMIT 1
      `,
      [key]
    );

    const playlistRow = playlistResult.rows[0];
    if (!playlistRow) {
      return null;
    }

    const tracksResult = await this.postgres.query<PlaylistTrackRow>(
      `
      SELECT playlist_id, position, query, title, url, added_by, added_at
      FROM playlist_tracks
      WHERE playlist_id = $1
      ORDER BY position ASC
      `,
      [playlistRow.id]
    );

    return this.toPlaylist(
      playlistRow,
      tracksResult.rows.map((trackRow) => this.toStoredTrack(trackRow))
    );
  }

  public async addTrack(
    guildId: string,
    playlistName: string,
    track: PlaylistTrackInput
  ): Promise<CustomPlaylist> {
    const result = await this.addTracks(guildId, playlistName, [track]);
    if (result.addedCount === 0) {
      throw new Error(`Limite de musiques atteinte (${this.limits.maxTracksPerPlaylist}).`);
    }

    return result.playlist;
  }

  public async addTracks(
    guildId: string,
    playlistName: string,
    tracks: PlaylistTrackInput[]
  ): Promise<{ addedCount: number; playlist: CustomPlaylist }> {
    const normalizedName = normalizePlaylistName(playlistName);
    const key = this.getKey(guildId, normalizedName);

    let addedCount = 0;

    await this.postgres.runInTransaction(async (client) => {
      const playlist = await this.mustGetPlaylistForUpdate(client, key, normalizedName);

      const currentCount = await this.countTracks(client, playlist.id);
      if (currentCount >= this.limits.maxTracksPerPlaylist) {
        return;
      }

      let nextPosition = currentCount + 1;
      for (const track of tracks) {
        if (nextPosition > this.limits.maxTracksPerPlaylist) {
          break;
        }

        await client.query(
          `
          INSERT INTO playlist_tracks (playlist_id, position, query, title, url, added_by, added_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            playlist.id,
            nextPosition,
            track.query,
            track.title,
            track.url ?? null,
            track.addedBy,
            new Date()
          ]
        );
        nextPosition += 1;
        addedCount += 1;
      }

      if (addedCount > 0) {
        await client.query(
          `
          UPDATE custom_playlists
          SET updated_at = NOW()
          WHERE id = $1
          `,
          [playlist.id]
        );
      }
    });

    const playlist = await this.getPlaylist(guildId, normalizedName);
    if (!playlist) {
      throw new Error("Playlist introuvable apres mise a jour.");
    }

    return { addedCount, playlist };
  }

  public async removeTrack(
    guildId: string,
    playlistName: string,
    index: number
  ): Promise<{ removed: StoredPlaylistTrack; playlist: CustomPlaylist }> {
    if (index < 1) {
      throw new Error("Index de piste invalide.");
    }

    const normalizedName = normalizePlaylistName(playlistName);
    const key = this.getKey(guildId, normalizedName);
    let removedTrack: StoredPlaylistTrack | null = null;

    await this.postgres.runInTransaction(async (client) => {
      const playlist = await this.mustGetPlaylistForUpdate(client, key, normalizedName);

      const tracksResult = await client.query<PlaylistTrackRow>(
        `
        SELECT playlist_id, position, query, title, url, added_by, added_at
        FROM playlist_tracks
        WHERE playlist_id = $1
        ORDER BY position ASC
        `,
        [playlist.id]
      );

      const target = tracksResult.rows[index - 1];
      if (!target) {
        throw new Error("Index de piste invalide.");
      }

      removedTrack = this.toStoredTrack(target);

      await client.query(
        `
        DELETE FROM playlist_tracks
        WHERE playlist_id = $1 AND position = $2
        `,
        [playlist.id, target.position]
      );

      await client.query(
        `
        UPDATE playlist_tracks
        SET position = position - 1
        WHERE playlist_id = $1 AND position > $2
        `,
        [playlist.id, target.position]
      );

      await client.query(
        `
        UPDATE custom_playlists
        SET updated_at = NOW()
        WHERE id = $1
        `,
        [playlist.id]
      );
    });

    if (!removedTrack) {
      throw new Error("Index de piste invalide.");
    }

    const playlist = await this.getPlaylist(guildId, normalizedName);
    if (!playlist) {
      throw new Error("Playlist introuvable apres suppression.");
    }

    return { removed: removedTrack, playlist };
  }

  private async mustGetPlaylistForUpdate(
    client: PoolClient,
    key: string,
    normalizedName: string
  ): Promise<PlaylistRow> {
    const result = await client.query<PlaylistRow>(
      `
      SELECT id, guild_id, name, key, created_by, created_at, updated_at
      FROM custom_playlists
      WHERE key = $1
      FOR UPDATE
      `,
      [key]
    );

    const row = result.rows[0];
    if (!row) {
      this.logger.warn({ key }, "Playlist introuvable");
      throw new Error(`Playlist introuvable: "${normalizedName}".`);
    }

    return row;
  }

  private async countTracks(client: PoolClient, playlistId: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM playlist_tracks
      WHERE playlist_id = $1
      `,
      [playlistId]
    );

    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  }

  private getKey(guildId: string, normalizedName: string): string {
    return `${guildId}:${normalizedName}`;
  }

  private toStoredTrack(row: PlaylistTrackRow): StoredPlaylistTrack {
    const payload: StoredPlaylistTrack = {
      query: row.query,
      title: row.title,
      addedBy: row.added_by,
      addedAt: row.added_at.toISOString()
    };

    if (row.url) {
      payload.url = row.url;
    }

    return payload;
  }

  private toPlaylist(row: PlaylistRow, tracks: StoredPlaylistTrack[]): CustomPlaylist {
    return {
      id: row.id,
      guildId: row.guild_id,
      name: row.name,
      key: row.key,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      tracks
    };
  }
}

function normalizePlaylistName(name: string): string {
  return name.trim().toLowerCase();
}

