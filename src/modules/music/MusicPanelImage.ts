import { createCanvas, loadImage, type CanvasRenderingContext2D, type Image } from "@napi-rs/canvas";

import { formatDuration } from "./trackHelpers";
import type { PanelState } from "./MusicPanel";
import type { MusicPanelDisplay } from "./types";

const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 720;
const PADDING = 26;
const ARTWORK_CACHE_TTL_MS = 5 * 60 * 1000;
const ARTWORK_TIMEOUT_MS = 1800;
const FOOTER_LABEL = "Quantum Neural Deck";
const MAX_INFO_LINES = 6;

const artworkCache = new Map<string, { image: Image; expiresAt: number }>();

export async function renderMusicPanelImage(
  display: MusicPanelDisplay,
  state: PanelState,
  status?: string
): Promise<Buffer> {
  const canvas = createCanvas(IMAGE_WIDTH, IMAGE_HEIGHT);
  const ctx = canvas.getContext("2d");

  const accentColor = display.accentColor ?? 0x2b90ff;
  const accent = numberToRgb(accentColor);
  const artwork = await loadArtwork(display.trackArtworkUrl);

  drawBackground(ctx, accent);
  drawMainCard(ctx, display, state, artwork, accent);

  const topY = 292;
  const cardGap = 14;
  const cardWidth = (IMAGE_WIDTH - PADDING * 2 - cardGap * 2) / 3;
  const cardHeight = 178;

  drawInfoCard(
    ctx,
    "Telemetrie",
    normalizeInfoLines(display.modeInfo, MAX_INFO_LINES),
    PADDING,
    topY,
    cardWidth,
    cardHeight,
    accent
  );
  drawInfoCard(
    ctx,
    "File Active",
    normalizeInfoLines(display.playlistInfo, MAX_INFO_LINES),
    PADDING + cardWidth + cardGap,
    topY,
    cardWidth,
    cardHeight,
    accent
  );
  drawInfoCard(
    ctx,
    "Integrite",
    normalizeInfoLines(display.queueHealthInfo, MAX_INFO_LINES),
    PADDING + (cardWidth + cardGap) * 2,
    topY,
    cardWidth,
    cardHeight,
    accent
  );

  const bottomY = topY + cardHeight + 14;
  const bottomWidth = (IMAGE_WIDTH - PADDING * 2 - cardGap) / 2;

  drawInfoCard(
    ctx,
    "Session",
    normalizeInfoLines(display.sessionInfo, MAX_INFO_LINES),
    PADDING,
    bottomY,
    bottomWidth,
    178,
    accent
  );

  drawInfoCard(
    ctx,
    "Vote Skip",
    normalizeInfoLines(display.voteSkipInfo, 5),
    PADDING + bottomWidth + cardGap,
    bottomY,
    bottomWidth,
    178,
    accent
  );

  drawFooter(ctx, status);
  return canvas.toBuffer("image/png");
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  accent: { r: number; g: number; b: number }
): void {
  const gradient = ctx.createLinearGradient(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  gradient.addColorStop(0, "rgba(4, 10, 18, 1)");
  gradient.addColorStop(0.5, "rgba(8, 18, 34, 1)");
  gradient.addColorStop(1, "rgba(6, 10, 20, 1)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);

  drawHoloGrid(ctx, accent);
  drawOrbs(ctx, accent);
}

function drawHoloGrid(
  ctx: CanvasRenderingContext2D,
  accent: { r: number; g: number; b: number }
): void {
  ctx.save();
  ctx.strokeStyle = rgba(accent, 0.14);
  ctx.lineWidth = 1;

  for (let x = 0; x <= IMAGE_WIDTH; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, IMAGE_HEIGHT);
    ctx.stroke();
  }

  for (let y = 0; y <= IMAGE_HEIGHT; y += 56) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(IMAGE_WIDTH, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawOrbs(
  ctx: CanvasRenderingContext2D,
  accent: { r: number; g: number; b: number }
): void {
  const left = ctx.createRadialGradient(180, 160, 30, 180, 160, 300);
  left.addColorStop(0, rgba(accent, 0.3));
  left.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);

  const right = ctx.createRadialGradient(IMAGE_WIDTH - 180, 120, 20, IMAGE_WIDTH - 180, 120, 280);
  right.addColorStop(0, "rgba(255, 120, 190, 0.25)");
  right.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = right;
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
}

function drawMainCard(
  ctx: CanvasRenderingContext2D,
  display: MusicPanelDisplay,
  state: PanelState,
  artwork: Image | null,
  accent: { r: number; g: number; b: number }
): void {
  const x = PADDING;
  const y = PADDING;
  const width = IMAGE_WIDTH - PADDING * 2;
  const height = 252;

  drawGlassCard(ctx, x, y, width, height, accent, 0.18);

  const artworkSize = 196;
  const artworkX = x + width - artworkSize - 24;
  const artworkY = y + 28;
  drawArtwork(ctx, artwork, artworkX, artworkY, artworkSize, accent);

  ctx.fillStyle = "rgba(240, 248, 255, 0.95)";
  ctx.font = "700 34px Bahnschrift, Segoe UI, sans-serif";
  ctx.fillText("Quantum Neural Deck", x + 24, y + 50);

  const titleX = x + 24;
  const titleY = y + 92;
  const titleMaxW = width - artworkSize - 88;
  ctx.fillStyle = "rgba(170, 220, 255, 1)";
  ctx.font = "700 32px Bahnschrift, Segoe UI, sans-serif";
  drawWrappedText(ctx, sanitizeInline(display.trackTitle), titleX, titleY, titleMaxW, 38, 2);

  ctx.fillStyle = "rgba(230, 240, 255, 0.92)";
  ctx.font = "500 22px Bahnschrift, Segoe UI, sans-serif";
  const authorY = titleY + 78;
  ctx.fillText(sanitizeInline(display.trackAuthor), titleX, authorY);

  const statusLabel = state.paused ? "PAUSE" : display.isPlaying ? "LIVE" : "IDLE";
  const chipY = authorY + 24;
  drawChip(ctx, `Source ${sanitizeInline(display.sourceName)}`, titleX, chipY, accent, 0.24);
  drawChip(ctx, `Etat ${statusLabel}`, titleX + 220, chipY, accent, 0.3);
  drawChip(ctx, `Autoplay ${state.autoplay ? "ON" : "OFF"}`, titleX + 370, chipY, accent, 0.22);

  const progressX = titleX;
  const progressY = y + height - 56;
  const progressW = width - artworkSize - 90;
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
  drawGlassCard(ctx, x, y, width, height, accent, 0.15);

  ctx.fillStyle = "rgba(245, 250, 255, 0.97)";
  ctx.font = "700 24px Bahnschrift, Segoe UI, sans-serif";
  ctx.fillText(title, x + 18, y + 34);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.11)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 16, y + 46);
  ctx.lineTo(x + width - 16, y + 46);
  ctx.stroke();

  ctx.fillStyle = "rgba(220, 232, 252, 0.95)";
  ctx.font = "500 19px Bahnschrift, Segoe UI, sans-serif";
  let cursorY = y + 74;

  for (const line of lines) {
    const wrapped = wrapLine(ctx, line, width - 40, 2);
    for (const chunk of wrapped) {
      if (cursorY > y + height - 12) {
        return;
      }

      ctx.fillText(`• ${sanitizeInline(chunk)}`, x + 18, cursorY);
      cursorY += 26;
    }
  }
}

function drawFooter(ctx: CanvasRenderingContext2D, status?: string): void {
  const content = status
    ? `${FOOTER_LABEL} | ${sanitizeInline(status).slice(0, 140)}`
    : `${FOOTER_LABEL} | Flux synchronise`;

  ctx.fillStyle = "rgba(202, 218, 240, 0.82)";
  ctx.font = "500 18px Bahnschrift, Segoe UI, sans-serif";
  ctx.fillText(content, PADDING, IMAGE_HEIGHT - 18);
}

function drawArtwork(
  ctx: CanvasRenderingContext2D,
  artwork: Image | null,
  x: number,
  y: number,
  size: number,
  accent: { r: number; g: number; b: number }
): void {
  drawGlassCard(ctx, x - 6, y - 6, size + 12, size + 12, accent, 0.2);

  if (artwork) {
    ctx.save();
    roundedRect(ctx, x, y, size, size, 18);
    ctx.clip();
    const drawableContext = ctx as CanvasRenderingContext2D & {
      drawImage(image: Image, dx: number, dy: number, dw: number, dh: number): void;
    };
    drawableContext.drawImage(artwork, x, y, size, size);
    ctx.restore();
    return;
  }

  const fallback = ctx.createLinearGradient(x, y, x + size, y + size);
  fallback.addColorStop(0, rgba(accent, 0.35));
  fallback.addColorStop(1, "rgba(36, 48, 78, 0.9)");
  ctx.fillStyle = fallback;
  roundedRect(ctx, x, y, size, size, 16);
  ctx.fill();

  ctx.fillStyle = "rgba(240, 248, 255, 0.88)";
  ctx.font = "700 72px Bahnschrift, Segoe UI, sans-serif";
  ctx.fillText("?", x + size / 2 - 18, y + size / 2 + 24);
}

function drawGlassCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  accent: { r: number; g: number; b: number },
  intensity: number
): void {
  const cardGradient = ctx.createLinearGradient(x, y, x + width, y + height);
  cardGradient.addColorStop(0, rgba(accent, intensity));
  cardGradient.addColorStop(1, "rgba(15, 24, 36, 0.75)");

  roundedRect(ctx, x, y, width, height, 22);
  ctx.fillStyle = cardGradient;
  ctx.fill();

  roundedRect(ctx, x, y, width, height, 22);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.lineWidth = 1.2;
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
  ctx.font = "600 15px Bahnschrift, Segoe UI, sans-serif";
  const width = Math.ceil(ctx.measureText(text).width) + 24;
  const height = 30;

  roundedRect(ctx, x, y, width, height, 10);
  ctx.fillStyle = rgba(accent, alpha);
  ctx.fill();

  ctx.fillStyle = "rgba(240, 248, 255, 0.95)";
  ctx.fillText(text, x + 12, y + 21);
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

  roundedRect(ctx, x, y, width, 18, 9);
  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.fill();

  const fill = ctx.createLinearGradient(x, y, x + fillWidth, y + 18);
  fill.addColorStop(0, rgba(accent, 0.92));
  fill.addColorStop(1, "rgba(255, 110, 170, 0.88)");
  roundedRect(ctx, x, y, fillWidth, 18, 9);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.fillStyle = "rgba(230, 242, 255, 0.92)";
  ctx.font = "500 14px Bahnschrift, Segoe UI, sans-serif";
  const elapsed = formatDuration(positionMs);
  const duration = formatDuration(durationMs);
  ctx.fillText(elapsed, x, y + 34);
  const durationWidth = ctx.measureText(duration).width;
  ctx.fillText(duration, x + width - durationWidth, y + 34);
}

function normalizeInfoLines(value: string, maxLines: number): string[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => sanitizeInline(line).trim())
    .filter((line) => line.length > 0);

  if (lines.length <= maxLines) {
    return lines;
  }

  const truncated = lines.slice(0, maxLines - 1);
  const remaining = lines.length - truncated.length;
  truncated.push(`... +${remaining}`);
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
    const width = ctx.measureText(candidate).width;
    if (width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      lines.push(word);
      current = "";
    }

    if (lines.length >= maxLines) {
      break;
    }
  }

  if (lines.length < maxLines && current.length > 0) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    lines.splice(maxLines);
  }

  if (lines.length === maxLines) {
    const last = lines[maxLines - 1] ?? "";
    if (ctx.measureText(last).width > maxWidth) {
      lines[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 2))}…`;
    }
  }

  return lines;
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
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    ctx.fillText(line, x, y + lineHeight * index);
  }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function numberToRgb(color: number): { r: number; g: number; b: number } {
  return {
    r: (color >> 16) & 0xff,
    g: (color >> 8) & 0xff,
    b: color & 0xff
  };
}

function rgba(rgb: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

  try {
    const image = (await Promise.race([
      loadImage(target),
      timeoutPromise(ARTWORK_TIMEOUT_MS)
    ])) as Image;
    artworkCache.set(target, {
      image,
      expiresAt: now + ARTWORK_CACHE_TTL_MS
    });
    return image;
  } catch {
    artworkCache.delete(target);
    return null;
  }
}

function timeoutPromise(delayMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("artwork timeout")), delayMs);
  });
}

