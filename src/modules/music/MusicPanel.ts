import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type APIEmbed,
  type ComponentInContainerData,
  type Embed,
  type TopLevelComponentData
} from "discord.js";

import { formatDuration } from "./trackHelpers";
import type { MusicPanelDisplay } from "./types";

export const PANEL_PREFIX = "music_panel";
const PROGRESS_BAR_SIZE = 16;
const SPINNER_FRAMES = ["|", "/", "-", "\\"];

export const PANEL_BUTTONS = {
  volumeDown: `${PANEL_PREFIX}:volume_down`,
  previous: `${PANEL_PREFIX}:previous`,
  pauseToggle: `${PANEL_PREFIX}:pause_toggle`,
  skip: `${PANEL_PREFIX}:skip`,
  volumeUp: `${PANEL_PREFIX}:volume_up`,
  shuffle: `${PANEL_PREFIX}:shuffle`,
  loop: `${PANEL_PREFIX}:loop`,
  stop: `${PANEL_PREFIX}:stop`,
  autoplay: `${PANEL_PREFIX}:autoplay`,
  voteSkip: `${PANEL_PREFIX}:vote_skip`,
  playlist: `${PANEL_PREFIX}:playlist`
} as const;

export const PANEL_SELECTS = {
  jump: `${PANEL_PREFIX}:jump`
} as const;

export type PanelAction = (typeof PANEL_BUTTONS)[keyof typeof PANEL_BUTTONS];
export type PanelSelectAction = (typeof PANEL_SELECTS)[keyof typeof PANEL_SELECTS];

export interface PanelState {
  paused: boolean;
  autoplay: boolean;
  repeatMode: "off" | "track" | "queue";
  hasPrevious: boolean;
}

export interface MusicPanelRender {
  components: readonly (TopLevelComponentData | ActionRowBuilder<any>)[];
  flags: MessageFlags.IsComponentsV2;
}

export function isMusicPanelAction(customId: string): customId is PanelAction {
  return Object.values(PANEL_BUTTONS).includes(customId as PanelAction);
}

export function isMusicPanelSelectAction(customId: string): customId is PanelSelectAction {
  return Object.values(PANEL_SELECTS).includes(customId as PanelSelectAction);
}

export function buildMusicPanel(
  display: MusicPanelDisplay,
  emoji: string,
  state: PanelState,
  status?: string,
  disableControls = false
): MusicPanelRender {
  const provider = formatProvider(display.sourceName);
  const playbackLabel = display.isPaused ? "PAUSE" : display.isPlaying ? "LIVE" : "IDLE";
  const motionFrame = display.isPlaying
    ? getSpinnerFrame(display.trackPositionMs)
    : display.isPaused
      ? "||"
      : "--";
  const progressBar = buildProgressBar(
    display.trackPositionMs,
    display.trackDurationMs,
    PROGRESS_BAR_SIZE
  );
  const elapsed = formatDuration(display.trackPositionMs);
  const duration = formatDuration(display.trackDurationMs);

  const title = display.trackUrl
    ? `### [${escapeMarkdown(display.trackTitle)}](${display.trackUrl})`
    : `### ${escapeMarkdown(display.trackTitle)}`;

  const author = escapeMarkdown(display.trackAuthor);
  const requester = display.requestedById ? `<@${display.requestedById}>` : "Inconnu";

  const heroText = [
    `## ${normalizeEmoji(emoji)} ${motionFrame} ${playbackLabel} | Quantum Control Deck`,
    title,
    `**${provider}** • **${formatDuration(display.trackDurationMs)}** • requested by ${requester}`,
    "",
    `**${elapsed}** ${inlineCode(progressBar)} **${duration}**`,
    `> ${author}`
  ].join("\n");

  const modeLines = normalizeMultiline(display.modeInfo).map((line) => `- ${escapeMarkdown(line)}`);
  const queueLines = normalizeMultiline(display.playlistInfo).map((line) => `- ${escapeMarkdown(line)}`);
  const healthLines = normalizeMultiline(display.queueHealthInfo).map((line) => `- ${escapeMarkdown(line)}`);
  const sessionLines = normalizeMultiline(display.sessionInfo).map((line) => `- ${escapeMarkdown(line)}`);
  const voteLines = normalizeMultiline(display.voteSkipInfo).map((line) => `- ${escapeMarkdown(line)}`);

  const containerComponents: ComponentInContainerData[] = [
    {
      type: ComponentType.Section,
      accessory: display.trackArtworkUrl
        ? {
            type: ComponentType.Thumbnail,
            media: {
              url: display.trackArtworkUrl
            },
            description: "Artwork"
          }
        : {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            label: "No artwork",
            customId: `${PANEL_PREFIX}:artwork_placeholder`,
            disabled: true
          },
      components: [{ type: ComponentType.TextDisplay, content: heroText }]
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: 2
    },
    {
      type: ComponentType.TextDisplay,
      content: `### Mode Deck\n${modeLines.join("\n")}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: 1
    },
    {
      type: ComponentType.TextDisplay,
      content: `### Playlist Queue\n${queueLines.join("\n")}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: 1
    },
    {
      type: ComponentType.TextDisplay,
      content: `### Queue Health\n${healthLines.join("\n")}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: 1
    },
    {
      type: ComponentType.TextDisplay,
      content: `### Session Pulse\n${sessionLines.join("\n")}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: 1
    },
    {
      type: ComponentType.TextDisplay,
      content: `### Vote Skip\n${voteLines.join("\n")}`
    },
    {
      type: ComponentType.TextDisplay,
      content: `> ${escapeMarkdown(buildFooterText(status))}`
    }
  ];

  const container: TopLevelComponentData = {
    type: ComponentType.Container,
    accentColor: display.accentColor ?? getPanelColor(display.sourceName),
    components: containerComponents
  };

  const components: Array<TopLevelComponentData | ActionRowBuilder<any>> = [container];
  components.push(...buildPanelComponents(state, disableControls));

  if (display.jumpTargets.length > 0) {
    const jumpRow = buildJumpRow(display.jumpTargets, disableControls);
    if (jumpRow) {
      components.push(jumpRow);
    }
  }

  return {
    components,
    flags: MessageFlags.IsComponentsV2
  };
}

export function buildPanelComponents(
  state: PanelState,
  disabled = false
): ActionRowBuilder<ButtonBuilder>[] {
  const pauseLabel = state.paused ? "Reprendre" : "Pause";
  const pauseEmoji = state.paused ? "\u{25B6}\u{FE0F}" : "\u{23EF}\u{FE0F}";
  const loopLabel =
    state.repeatMode === "off"
      ? "Boucle:Arret"
      : state.repeatMode === "track"
        ? "Boucle:Piste"
        : "Boucle:File";
  const autoplayLabel = state.autoplay ? "Lecture auto:Oui" : "Lecture auto:Non";

  const rowOne = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.volumeDown)
      .setLabel("Moins")
      .setEmoji("\u{1F509}")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.previous)
      .setLabel("Retour")
      .setEmoji("\u{23EE}\u{FE0F}")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.pauseToggle)
      .setLabel(pauseLabel)
      .setEmoji(pauseEmoji)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.skip)
      .setLabel("Suivante")
      .setEmoji("\u{23ED}\u{FE0F}")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.volumeUp)
      .setLabel("Plus")
      .setEmoji("\u{1F50A}")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  if (!state.hasPrevious || disabled) {
    rowOne.components[1]?.setDisabled(true);
  }

  const rowTwo = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.shuffle)
      .setLabel("Melange")
      .setEmoji("\u{1F500}")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.loop)
      .setLabel(loopLabel)
      .setEmoji("\u{1F501}")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.stop)
      .setLabel("Arret")
      .setEmoji("\u{23F9}\u{FE0F}")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.autoplay)
      .setLabel(autoplayLabel)
      .setEmoji("\u{1F916}")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.voteSkip)
      .setLabel("Vote Skip")
      .setEmoji("\u{1F5F3}\u{FE0F}")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  const rowThree = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.playlist)
      .setLabel("File")
      .setEmoji("\u{1F3B6}")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  return [rowOne, rowTwo, rowThree];
}

export function disablePanelRows(
  rows: ReadonlyArray<{ components: ReadonlyArray<unknown> }>
): ActionRowBuilder<any>[] {
  const convertedRows: ActionRowBuilder<any>[] = [];
  for (const row of rows) {
    const actionRow = new ActionRowBuilder<any>();
    for (const component of row.components) {
      if (!component || typeof component !== "object") {
        continue;
      }

      const type = (component as { type?: number }).type;
      if (type === ComponentType.Button) {
        actionRow.addComponents(ButtonBuilder.from(component as any).setDisabled(true));
        continue;
      }

      if (type === ComponentType.StringSelect) {
        actionRow.addComponents(StringSelectMenuBuilder.from(component as any).setDisabled(true));
      }
    }

    if (actionRow.components.length > 0) {
      convertedRows.push(actionRow);
    }
  }

  return convertedRows;
}

export function withPanelStatus(
  embeds: ReadonlyArray<Embed | APIEmbed>,
  status: string
): EmbedBuilder[] {
  const first = embeds[0];
  if (!first) {
    return [];
  }

  const builder = EmbedBuilder.from(first).setTimestamp(new Date());
  builder.setFooter({ text: buildFooterText(status) });
  return [builder];
}

function buildJumpRow(
  jumpTargets: MusicPanelDisplay["jumpTargets"],
  disabled: boolean
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (jumpTargets.length === 0) {
    return null;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(PANEL_SELECTS.jump)
    .setPlaceholder("Jump to a track")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled)
    .addOptions(
      jumpTargets.slice(0, 25).map((option) => {
        const base = {
          label: truncateLabel(option.label, 100),
          value: option.value
        };

        if (!option.description) {
          return base;
        }

        return {
          ...base,
          description: truncateLabel(option.description, 100)
        };
      })
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function formatProvider(provider: string): string {
  switch (provider.toLowerCase()) {
    case "youtube":
      return "YouTube";
    case "youtube music":
    case "youtubemusic":
    case "youtube_music":
      return "YouTube Music";
    case "youtube_search":
      return "Recherche YouTube";
    case "youtube_music_search":
      return "Recherche YouTube Music";
    case "soundcloud":
      return "SoundCloud";
    case "spotify":
      return "Spotify";
    case "apple_music":
      return "Apple Music";
    case "deezer":
      return "Deezer";
    case "direct_url":
      return "URL directe";
    default:
      return provider;
  }
}

function getPanelColor(sourceName: string): number {
  switch (sourceName.toLowerCase()) {
    case "youtube":
      return 0xff2d55;
    case "youtube music":
    case "youtubemusic":
    case "youtube_music":
      return 0xff3d71;
    case "soundcloud":
      return 0xff7a18;
    case "spotify":
      return 0x1ed760;
    case "apple_music":
      return 0xfa2d48;
    case "deezer":
      return 0x00b8ff;
    default:
      return 0x2b90ff;
  }
}

function buildProgressBar(positionMs: number, durationMs: number, size: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "[live stream]";
  }

  const clampedPosition = Math.max(0, Math.min(positionMs, durationMs));
  const ratio = durationMs > 0 ? clampedPosition / durationMs : 0;
  const filled = Math.max(0, Math.min(size, Math.round(ratio * size)));
  const left = "=".repeat(filled);
  const right = "-".repeat(Math.max(0, size - filled));
  return `[${left}${right}]`;
}

function getSpinnerFrame(positionMs: number): string {
  if (!Number.isFinite(positionMs) || positionMs <= 0) {
    return SPINNER_FRAMES[0] ?? "|";
  }

  const index = Math.floor(positionMs / 1800) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? "|";
}

function buildFooterText(status?: string): string {
  const base = "Control Deck actif";
  if (!status) {
    return base;
  }

  const safeStatus = status.replace(/\s+/g, " ").trim().slice(0, 180);
  if (!safeStatus) {
    return base;
  }

  return `${base} | ${safeStatus}`.slice(0, 2048);
}

function normalizeMultiline(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return ["Aucune donnee disponible."];
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  if (!trimmed) {
    return "\u{1F3B5}";
  }

  return trimmed;
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function truncateLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
