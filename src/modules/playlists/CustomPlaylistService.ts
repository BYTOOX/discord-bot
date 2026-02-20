import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "pino";

import type { CustomPlaylist, PlaylistTrackInput, StoredPlaylistTrack } from "./types";

interface PlaylistStoreFile {
  playlists: CustomPlaylist[];
}

interface PlaylistLimits {
  maxPlaylists: number;
  maxTracksPerPlaylist: number;
}

export class CustomPlaylistService {
  private readonly playlists = new Map<string, CustomPlaylist>();
  private loaded = false;

  public constructor(
    private readonly storePath: string,
    private readonly limits: PlaylistLimits,
    private readonly logger: Logger
  ) {}

  public async createPlaylist(
    guildId: string,
    name: string,
    createdBy: string
  ): Promise<CustomPlaylist> {
    await this.ensureLoaded();

    const normalizedName = normalizePlaylistName(name);
    const key = this.getKey(guildId, normalizedName);

    if (this.playlists.has(key)) {
      throw new Error(`La playlist "${normalizedName}" existe deja.`);
    }

    const guildPlaylists = await this.listPlaylists(guildId);
    if (guildPlaylists.length >= this.limits.maxPlaylists) {
      throw new Error(`Limite de playlists atteinte (${this.limits.maxPlaylists}).`);
    }

    const now = new Date().toISOString();
    const playlist: CustomPlaylist = {
      id: randomUUID(),
      guildId,
      name: normalizedName,
      key,
      createdBy,
      createdAt: now,
      updatedAt: now,
      tracks: []
    };

    this.playlists.set(key, playlist);
    await this.persist();
    return playlist;
  }

  public async listPlaylists(guildId: string): Promise<CustomPlaylist[]> {
    await this.ensureLoaded();

    return [...this.playlists.values()]
      .filter((playlist) => playlist.guildId === guildId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async getPlaylist(guildId: string, name: string): Promise<CustomPlaylist | null> {
    await this.ensureLoaded();
    const key = this.getKey(guildId, normalizePlaylistName(name));
    return this.playlists.get(key) ?? null;
  }

  public async addTrack(
    guildId: string,
    playlistName: string,
    track: PlaylistTrackInput
  ): Promise<CustomPlaylist> {
    const playlist = await this.mustGetPlaylist(guildId, playlistName);

    if (playlist.tracks.length >= this.limits.maxTracksPerPlaylist) {
      throw new Error(`Limite de musiques atteinte (${this.limits.maxTracksPerPlaylist}).`);
    }

    const storedTrack: StoredPlaylistTrack = {
      ...track,
      addedAt: new Date().toISOString()
    };

    playlist.tracks.push(storedTrack);
    playlist.updatedAt = new Date().toISOString();
    await this.persist();
    return playlist;
  }

  public async addTracks(
    guildId: string,
    playlistName: string,
    tracks: PlaylistTrackInput[]
  ): Promise<{ addedCount: number; playlist: CustomPlaylist }> {
    const playlist = await this.mustGetPlaylist(guildId, playlistName);

    let addedCount = 0;
    for (const track of tracks) {
      if (playlist.tracks.length >= this.limits.maxTracksPerPlaylist) {
        break;
      }

      const storedTrack: StoredPlaylistTrack = {
        ...track,
        addedAt: new Date().toISOString()
      };
      playlist.tracks.push(storedTrack);
      addedCount += 1;
    }

    if (addedCount > 0) {
      playlist.updatedAt = new Date().toISOString();
      await this.persist();
    }

    return { addedCount, playlist };
  }

  public async removeTrack(
    guildId: string,
    playlistName: string,
    index: number
  ): Promise<{ removed: StoredPlaylistTrack; playlist: CustomPlaylist }> {
    const playlist = await this.mustGetPlaylist(guildId, playlistName);
    if (index < 1 || index > playlist.tracks.length) {
      throw new Error("Index de piste invalide.");
    }

    const removed = playlist.tracks.splice(index - 1, 1)[0];
    if (!removed) {
      throw new Error("Index de piste invalide.");
    }

    playlist.updatedAt = new Date().toISOString();
    await this.persist();
    return { removed, playlist };
  }

  private async mustGetPlaylist(guildId: string, name: string): Promise<CustomPlaylist> {
    const playlist = await this.getPlaylist(guildId, name);
    if (!playlist) {
      throw new Error(`Playlist introuvable: "${normalizePlaylistName(name)}".`);
    }

    return playlist;
  }

  private getKey(guildId: string, normalizedName: string): string {
    return `${guildId}:${normalizedName}`;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as PlaylistStoreFile;
      for (const playlist of parsed.playlists ?? []) {
        this.playlists.set(playlist.key, playlist);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn({ err: error }, "Impossible de charger le stockage playlists, store vide");
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const payload: PlaylistStoreFile = { playlists: [...this.playlists.values()] };
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(payload, null, 2), "utf8");
  }
}

function normalizePlaylistName(name: string): string {
  return name.trim().toLowerCase();
}
