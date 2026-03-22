import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  StringSelectMenuBuilder,
  type ComponentInContainerData,
  type TopLevelComponentData
} from "discord.js";

import { formatDuration } from "./trackHelpers";
import type { MusicPanelDisplay } from "./types";

export const PANEL_PREFIX = "music_panel";
const PROGRESS_BAR_SIZE = 18;

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
  jump: `${PANEL_PREFIX}:jump`,
  filter: `${PANEL_PREFIX}:filter`
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
  const playback = display.isPaused ? "⏸️ PAUSE" : display.isPlaying ? "🔴 LIVE" : "🌙 IDLE";
  const progressBar = buildProgressBar(display.trackPositionMs, display.trackDurationMs, PROGRESS_BAR_SIZE);

  const title = display.trackUrl
    ? `### [${escapeMarkdown(display.trackTitle)}](${display.trackUrl})`
    : `### ${escapeMarkdown(display.trackTitle)}`;

  const heroText = [
    `## ${normalizeEmoji(emoji)} Quantum Neural Deck`,
    title,
    `**${getProviderEmoji(display.sourceName)} ${provider}** • **${playback}** • 🎧 demandé par ${display.requestedById ? `<@${display.requestedById}>` : "n/a"}`,
    "",
    `${inlineCode(progressBar)}  ${formatDuration(display.trackPositionMs)} / ${formatDuration(display.trackDurationMs)}`,
    `> 🎤 ${escapeMarkdown(display.trackAuthor)}`
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
            label: "🖼️ Pas de cover",
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
      content: `### 📡 Telemetrie\n${modeLines.join("\n")}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: 1
    },
    {
      type: ComponentType.TextDisplay,
      content: `### 🎶 File Active\n${queueLines.join("\n")}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: 1
    },
    {
      type: ComponentType.TextDisplay,
      content: `### 🛡️ Integrite\n${healthLines.join("\n")}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: 1
    },
    {
      type: ComponentType.TextDisplay,
      content: `### 🧠 Session\n${sessionLines.join("\n")}`
    },
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: 1
    },
    {
      type: ComponentType.TextDisplay,
      content: `### 🗳️ Vote Skip\n${voteLines.join("\n")}`
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

  const filterRow = buildFilterRow(disableControls);
  if (filterRow) {
    components.push(filterRow);
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
  const pauseLabel = state.paused ? "▶️ Reprendre" : "⏸️ Pause";
  const loopLabel =
    state.repeatMode === "off"
      ? "🔁 Loop:Off"
      : state.repeatMode === "track"
        ? "🔂 Loop:1"
        : "🔁 Loop:All";
  const autoplayLabel = state.autoplay ? "✨ Auto:On" : "💤 Auto:Off";

  const rowOne = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.volumeDown)
      .setLabel("🔉 Vol-")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.previous)
      .setLabel("⏮️ Retour")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.pauseToggle)
      .setLabel(pauseLabel)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.skip)
      .setLabel("⏭️ Skip")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.volumeUp)
      .setLabel("🔊 Vol+")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  if (!state.hasPrevious || disabled) {
    rowOne.components[1]?.setDisabled(true);
  }

  const rowTwo = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.shuffle)
      .setLabel("🔀 Shuffle")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.loop)
      .setLabel(loopLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.stop)
      .setLabel("⏹️ Stop")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.autoplay)
      .setLabel(autoplayLabel)
      .setStyle(state.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.voteSkip)
      .setLabel("🗳️ Vote")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  const rowThree = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.playlist)
      .setLabel("📜 Apercu file")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  return [rowOne, rowTwo, rowThree];
}

export function disablePanelRows(
  rows: ReadonlyArray<{ components: ReadonlyArray<unknown> }>
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  return rows.map((row) => {
    const mapped = row.components
      .map((component) => {
        if (!component || typeof component !== "object") {
          return null;
        }

        const type = (component as { type?: number }).type;
        if (type === ComponentType.Button) {
          return ButtonBuilder.from(component as never).setDisabled(true);
        }

        if (type === ComponentType.StringSelect) {
          return StringSelectMenuBuilder.from(component as never).setDisabled(true);
        }

        return null;
      })
      .filter(
        (component): component is ButtonBuilder | StringSelectMenuBuilder => component !== null
      );

    return new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(mapped);
  });
}

export function withPanelStatus(status: string): string {
  return buildFooterText(status);
}

function buildJumpRow(
  targets: MusicPanelDisplay["jumpTargets"],
  disabled: boolean
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const options = targets.slice(0, 25).map((target) => {
    const option: { label: string; value: string; description?: string } = {
      label: target.label.slice(0, 100),
      value: target.value
    };

    if (target.description) {
      option.description = target.description.slice(0, 100);
    }

    return option;
  });

  if (options.length === 0) {
    return null;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(PANEL_SELECTS.jump)
    .setPlaceholder("⏭️ Jump instantane dans la file")
    .addOptions(options)
    .setDisabled(disabled);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildFilterRow(disabled: boolean): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const select = new StringSelectMenuBuilder()
    .setCustomId(PANEL_SELECTS.filter)
    .setPlaceholder("🎚️ Filtre DJ")
    .addOptions(
      {
        label: "🫧 Reset",
        value: "reset",
        description: "Supprime tous les filtres"
      },
      {
        label: "⚡ Nightcore",
        value: "nightcore",
        description: "Pitch et vitesse plus nerveux"
      },
      {
        label: "🌊 Vaporwave",
        value: "vaporwave",
        description: "Rendu ralenti et plus doux"
      },
      {
        label: "🫨 Bassboost",
        value: "bassboost",
        description: "Renforce les basses"
      },
      {
        label: "🎸 Rock",
        value: "rock",
        description: "EQ plus incisif"
      }
    )
    .setDisabled(disabled);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildProgressBar(positionMs: number, durationMs: number, size: number): string {
  if (durationMs <= 0) {
    return "·".repeat(size);
  }

  const ratio = Math.max(0, Math.min(1, positionMs / Math.max(durationMs, 1)));
  const cursor = Math.min(size - 1, Math.max(0, Math.round(ratio * (size - 1))));
  let bar = "";

  for (let index = 0; index < size; index += 1) {
    if (index === cursor) {
      bar += "◉";
      continue;
    }

    bar += index < cursor ? "─" : "·";
  }

  return bar;
}

function normalizeEmoji(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "🎛️";
}

function formatProvider(sourceName: string): string {
  const source = sourceName.trim().toLowerCase();
  if (source.includes("spotify")) {
    return "Spotify";
  }

  if (source.includes("youtube")) {
    return "YouTube";
  }

  if (source === "unknown") {
    return "Source inconnue";
  }

  return sourceName || "Source inconnue";
}

function getPanelColor(sourceName: string): number {
  const source = sourceName.trim().toLowerCase();

  if (source.includes("spotify")) {
    return 0x1ed760;
  }

  if (source.includes("youtube")) {
    return 0xff355e;
  }

  return 0x2b90ff;
}

function buildFooterText(status?: string): string {
  const timestamp = new Date().toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  if (status && status.trim().length > 0) {
    return `✨ Neural Deck • ${status.trim().slice(0, 180)} • ${timestamp}`;
  }

  return `✨ Neural Deck • Synchronisation live • ${timestamp}`;
}

function getProviderEmoji(sourceName: string): string {
  const source = sourceName.trim().toLowerCase();
  if (source.includes("spotify")) {
    return "🟢";
  }

  if (source.includes("youtube")) {
    return "🔴";
  }

  return "🎵";
}

function normalizeMultiline(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function inlineCode(value: string): string {
  return `\`${value}\``;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

