import { createCanvas, loadImage, type CanvasRenderingContext2D, type Image } from "@napi-rs/canvas";

import { formatDuration } from "./trackHelpers";
import type { PanelState } from "./MusicPanel";
import type { MusicPanelDisplay } from "./types";

const IMAGE_WIDTH = 1180;
const IMAGE_HEIGHT = 720;
const PADDING = 28;
const ARTWORK_CACHE_TTL_MS = 5 * 60 * 1000;
const ARTWORK_TIMEOUT_MS = 1800;
const MAX_QUEUE_LINES = 6;
const MAX_MODE_LINES = 5;
const MAX_HEALTH_LINES = 5;
const MAX_SESSION_LINES = 5;
const MAX_VOTE_LINES = 4;
const FOOTER_LABEL = "Quantum Jukebox";

const artworkCache = new Map<string, { image: Image; expiresAt: number }>();

export async function renderMusicPanelImage(
  display: MusicPanelDisplay,
  state: PanelState,
  status?: string
): Promise<Buffer> {
  const canvas = createCanvas(IMAGE_WIDTH, IMAGE_HEIGHT);
  const ctx = canvas.getContext("2d");

  const accentColor = display.accentColor ?? 0x2b90ff;
  const accentRgb = numberToRgb(accentColor);
  const artwork = await loadArtwork(display.trackArtworkUrl);

  drawBackground(ctx, accentRgb);
  drawTopBlock(ctx, display, state, artwork, accentRgb);

  const cardY = 274;
  const cardGap = 16;
  const cardWidth = (IMAGE_WIDTH - PADDING * 2 - cardGap * 2) / 3;
  const cardHeight = 182;

  drawInfoCard(
    ctx,
    "Mode Deck",
    normalizeInfoLines(display.modeInfo, MAX_MODE_LINES),
    PADDING,
    cardY,
    cardWidth,
    cardHeight,
    accentRgb
  );
  drawInfoCard(
    ctx,
    "Playlist Queue",
    normalizeInfoLines(display.playlistInfo, MAX_QUEUE_LINES),
    PADDING + cardWidth + cardGap,
    cardY,
    cardWidth,
    cardHeight,
    accentRgb
  );
  drawInfoCard(
    ctx,
    "Queue Health",
    normalizeInfoLines(display.queueHealthInfo, MAX_HEALTH_LINES),
    PADDING + (cardWidth + cardGap) * 2,
    cardY,
    cardWidth,
    cardHeight,
    accentRgb
  );

  const bottomY = cardY + cardHeight + 16;
  const bottomCardWidth = (IMAGE_WIDTH - PADDING * 2 - cardGap) / 2;
  const bottomCardHeight = 182;

  drawInfoCard(
    ctx,
    "Session Pulse",
    normalizeInfoLines(display.sessionInfo, MAX_SESSION_LINES),
    PADDING,
    bottomY,
    bottomCardWidth,
    bottomCardHeight,
    accentRgb
  );
  drawInfoCard(
    ctx,
    "Vote Skip",
    normalizeInfoLines(display.voteSkipInfo, MAX_VOTE_LINES),
    PADDING + bottomCardWidth + cardGap,
    bottomY,
    bottomCardWidth,
    bottomCardHeight,
    accentRgb
  );

  drawFooter(ctx, status);
  return canvas.toBuffer("image/png");
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  accent: { r: number; g: number; b: number }
): void {
  const gradient = ctx.createLinearGradient(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  gradient.addColorStop(0, "rgba(8, 12, 18, 1)");
  gradient.addColorStop(1, "rgba(10, 20, 26, 1)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);

  const glow = ctx.createRadialGradient(
    IMAGE_WIDTH - 160,
    80,
    20,
    IMAGE_WIDTH - 160,
    80,
    500
  );
  glow.addColorStop(0, rgba(accent, 0.35));
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);

  const stripe = ctx.createLinearGradient(0, 0, IMAGE_WIDTH, 0);
  stripe.addColorStop(0, rgba(accent, 0.9));
  stripe.addColorStop(1, rgba(accent, 0.2));
  ctx.fillStyle = stripe;
  ctx.fillRect(0, 0, 6, IMAGE_HEIGHT);
}

function drawTopBlock(
  ctx: CanvasRenderingContext2D,
  display: MusicPanelDisplay,
  state: PanelState,
  artwork: Image | null,
  accent: { r: number; g: number; b: number }
): void {
  const blockX = PADDING;
  const blockY = PADDING;
  const blockW = IMAGE_WIDTH - PADDING * 2;
  const blockH = 230;
  drawGlassPanel(ctx, blockX, blockY, blockW, blockH, accent, 0.17);

  const artSize = 182;
  const artX = blockX + blockW - artSize - 22;
  const artY = blockY + 24;
  drawArtwork(ctx, artwork, artX, artY, artSize, accent);

  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.font = "700 36px Segoe UI, Arial, sans-serif";
  ctx.fillText("Quantum Control Deck V3", blockX + 22, blockY + 48);

  const titleX = blockX + 22;
  const titleY = blockY + 88;
  const titleMaxW = blockW - artSize - 76;
  ctx.fillStyle = "rgba(173, 219, 255, 1)";
  ctx.font = "700 30px Segoe UI, Arial, sans-serif";
  drawWrappedText(ctx, sanitizeInline(display.trackTitle), titleX, titleY, titleMaxW, 36, 2);

  ctx.fillStyle = "rgba(232, 242, 255, 0.9)";
  ctx.font = "500 22px Segoe UI, Arial, sans-serif";
  const authorY = titleY + 78;
  ctx.fillText(sanitizeInline(display.trackAuthor), titleX, authorY);

  const chipsY = authorY + 24;
  const statusLabel = state.paused ? "PAUSED" : display.isPlaying ? "LIVE" : "IDLE";
  drawChip(ctx, `Source ${display.sourceName}`, titleX, chipsY, accent, 0.24);
  drawChip(ctx, `State ${statusLabel}`, titleX + 185, chipsY, accent, 0.28);
  drawChip(ctx, `Dur ${formatDuration(display.trackDurationMs)}`, titleX + 325, chipsY, accent, 0.2);

  const progressX = titleX;
  const progressY = blockY + blockH - 56;
  const progressW = blockW - artSize - 78;
  drawProgress(ctx, progressX, progressY, progressW, display.trackPositionMs, display.trackDurationMs, accent);
}

function drawInfoCard(
  ctx: CanvasRenderingContext2D,
  title: string,
  lines: string[],
  x: number,
  y: number,
  width: number,
  height: number,
  accent: { r: number; g: number; b: number }
): void {
  drawGlassPanel(ctx, x, y, width, height, accent, 0.14);

  ctx.fillStyle = "rgba(245, 250, 255, 0.96)";
  ctx.font = "700 25px Segoe UI, Arial, sans-serif";
  ctx.fillText(title, x + 18, y + 34);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 18, y + 48);
  ctx.lineTo(x + width - 18, y + 48);
  ctx.stroke();

  ctx.fillStyle = "rgba(220, 234, 252, 0.95)";
  ctx.font = "500 20px Segoe UI, Arial, sans-serif";
  let cursorY = y + 78;
  for (const line of lines) {
    const wrapped = wrapLine(ctx, line, width - 40, 2);
    for (const chunk of wrapped) {
      if (cursorY > y + height - 14) {
        return;
      }
      ctx.fillText(`- ${sanitizeInline(chunk)}`, x + 18, cursorY);
      cursorY += 27;
    }
  }
}

function drawFooter(ctx: CanvasRenderingContext2D, status?: string): void {
  const footerText = status
    ? `${FOOTER_LABEL} | ${sanitizeInline(status).slice(0, 120)}`
    : `${FOOTER_LABEL} | Live panel refresh enabled`;
  ctx.fillStyle = "rgba(202, 218, 240, 0.8)";
  ctx.font = "500 18px Segoe UI, Arial, sans-serif";
  ctx.fillText(footerText, PADDING, IMAGE_HEIGHT - 18);
}

function drawArtwork(
  ctx: CanvasRenderingContext2D,
  artwork: Image | null,
  x: number,
  y: number,
  size: number,
  accent: { r: number; g: number; b: number }
): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 18);
  ctx.clip();

  if (artwork) {
    (ctx as CanvasRenderingContext2D & { drawImage: (...args: unknown[]) => void }).drawImage(
      artwork,
      x,
      y,
      size,
      size
    );
  } else {
    const fallback = ctx.createLinearGradient(x, y, x + size, y + size);
    fallback.addColorStop(0, "rgba(45, 65, 90, 0.95)");
    fallback.addColorStop(1, "rgba(20, 25, 35, 0.95)");
    ctx.fillStyle = fallback;
    ctx.fillRect(x, y, size, size);

    ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
    ctx.font = "700 40px Segoe UI, Arial, sans-serif";
    ctx.fillText("NO ART", x + 26, y + 98);
  }
  ctx.restore();

  ctx.strokeStyle = rgba(accent, 0.72);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 18);
  ctx.stroke();
}

function drawGlassPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  accent: { r: number; g: number; b: number },
  opacity: number
): void {
  const panelGradient = ctx.createLinearGradient(x, y, x + width, y + height);
  panelGradient.addColorStop(0, `rgba(21, 30, 44, ${opacity + 0.2})`);
  panelGradient.addColorStop(1, `rgba(9, 14, 22, ${opacity + 0.12})`);
  ctx.fillStyle = panelGradient;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 18);
  ctx.fill();

  ctx.strokeStyle = rgba(accent, 0.48);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 18);
  ctx.stroke();
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  accent: { r: number; g: number; b: number },
  alpha: number
): void {
  ctx.font = "600 17px Segoe UI, Arial, sans-serif";
  const width = Math.ceil(ctx.measureText(text).width) + 22;
  const height = 30;
  ctx.fillStyle = rgba(accent, alpha);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 15);
  ctx.fill();

  ctx.fillStyle = "rgba(245, 250, 255, 0.95)";
  ctx.fillText(text, x + 11, y + 21);
}

function drawProgress(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  positionMs: number,
  durationMs: number,
  accent: { r: number; g: number; b: number }
): void {
  const safeDuration = durationMs > 0 ? durationMs : 1;
  const ratio = Math.max(0, Math.min(1, positionMs / safeDuration));
  const fillWidth = Math.max(8, Math.round(width * ratio));

  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.beginPath();
  ctx.roundRect(x, y, width, 18, 9);
  ctx.fill();

  const fill = ctx.createLinearGradient(x, y, x + fillWidth, y + 18);
  fill.addColorStop(0, rgba(accent, 0.95));
  fill.addColorStop(1, rgba(accent, 0.55));
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, fillWidth, 18, 9);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, 18, 9);
  ctx.stroke();

  ctx.fillStyle = "rgba(230, 242, 255, 0.95)";
  ctx.font = "600 18px Segoe UI, Arial, sans-serif";
  ctx.fillText(formatDuration(positionMs), x, y + 44);
  const duration = formatDuration(durationMs);
  const durationWidth = ctx.measureText(duration).width;
  ctx.fillText(duration, x + width - durationWidth, y + 44);
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
): void {
  const lines = wrapLine(ctx, text, maxWidth, maxLines);
  lines.forEach((line, index) => {
    ctx.fillText(line, x, y + lineHeight * index);
  });
}

function normalizeInfoLines(value: string, maxLines: number): string[] {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*]\s*/, ""));
  if (lines.length === 0) {
    return ["No data"];
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  const truncated = lines.slice(0, maxLines - 1);
  const remaining = lines.length - truncated.length;
  truncated.push(`+${remaining} more line(s)`);
  return truncated;
}

function wrapLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = sanitizeInline(text).split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth || current.length === 0) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) {
      break;
    }
  }

  if (lines.length < maxLines && current.length > 0) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }

  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    const last = lines[maxLines - 1];
    if (last) {
      lines[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 3))}...`;
    }
  }

  return lines;
}

function numberToRgb(color: number): { r: number; g: number; b: number } {
  return {
    r: (color >> 16) & 0xff,
    g: (color >> 8) & 0xff,
    b: color & 0xff
  };
}

function rgba(rgb: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.max(0, Math.min(1, alpha))})`;
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[\u0000-\u001f]/g, "").trim();
}

async function loadArtwork(url: string | undefined): Promise<Image | null> {
  const target = url?.trim();
  if (!target) {
    return null;
  }

  const now = Date.now();
  const cached = artworkCache.get(target);
  if (cached && cached.expiresAt > now) {
    return cached.image;
  }

  if (cached && cached.expiresAt <= now) {
    artworkCache.delete(target);
  }

  try {
    const image = (await Promise.race([
      loadImage(target, { maxRedirects: 2 }),
      timeoutPromise(ARTWORK_TIMEOUT_MS)
    ])) as Image;
    artworkCache.set(target, { image, expiresAt: now + ARTWORK_CACHE_TTL_MS });
    return image;
  } catch {
    return null;
  }
}

function timeoutPromise(delayMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Artwork timeout")), delayMs);
  });
}
