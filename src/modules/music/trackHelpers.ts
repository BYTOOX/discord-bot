import type { Track, UnresolvedTrack } from "lavalink-client";

type QueueTrack = Track | UnresolvedTrack;

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "direct";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }

  return `${minutes}:${pad(seconds)}`;
}

export function displayTrack(track: QueueTrack): string {
  const title = track.info.title ?? "Titre inconnu";
  const author = track.info.author ?? "Auteur inconnu";
  return `${title} - ${author}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
