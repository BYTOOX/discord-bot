import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbed,
  type Embed
} from "discord.js";

import { formatDuration } from "./trackHelpers";
import type { EnqueueResult } from "./types";

export const PANEL_PREFIX = "music_panel";

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
  playlist: `${PANEL_PREFIX}:playlist`
} as const;

export type PanelAction = (typeof PANEL_BUTTONS)[keyof typeof PANEL_BUTTONS];

export interface PanelState {
  paused: boolean;
  autoplay: boolean;
  repeatMode: "off" | "track" | "queue";
  hasPrevious: boolean;
}

export function isMusicPanelAction(customId: string): customId is PanelAction {
  return Object.values(PANEL_BUTTONS).includes(customId as PanelAction);
}

export function buildPlayPanel(
  result: EnqueueResult,
  requestedById: string,
  emoji: string,
  state: PanelState,
  modeInfo: string
): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const provider = formatProvider(result.provider);
  const title = result.firstTrackUrl
    ? `[${escapeTitle(result.firstTrackTitle)}](${result.firstTrackUrl})`
    : escapeTitle(result.firstTrackTitle);

  const embed = new EmbedBuilder()
    .setColor(0x101826)
    .setTitle(`${emoji} Panneau Musique`)
    .setDescription(title)
    .addFields(
      { name: "Demande par", value: `<@${requestedById}>`, inline: true },
      {
        name: "Duree",
        value: formatDuration(result.firstTrackDurationMs ?? 0),
        inline: true
      },
      { name: "Auteur", value: result.firstTrackAuthor ?? "Inconnu", inline: true },
      { name: "Source", value: provider, inline: true },
      {
        name: "Ajout file",
        value: result.isPlaylist ? `${result.addedCount} piste(s)` : `+${result.addedCount}`,
        inline: true
      },
      {
        name: "Playlist detectee",
        value: result.playlistName ?? "Aucune",
        inline: true
      },
      {
        name: "Mode",
        value: modeInfo,
        inline: false
      }
    )
    .setFooter({ text: "Controles rapides disponibles ci-dessous" });

  if (result.firstTrackArtworkUrl) {
    embed.setThumbnail(result.firstTrackArtworkUrl);
  }

  return {
    embed,
    components: buildPanelComponents(state)
  };
}

export function buildPanelComponents(state: PanelState): ActionRowBuilder<ButtonBuilder>[] {
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
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.previous)
      .setLabel("Retour")
      .setEmoji("\u{23EE}\u{FE0F}")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.pauseToggle)
      .setLabel(pauseLabel)
      .setEmoji(pauseEmoji)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.skip)
      .setLabel("Suivante")
      .setEmoji("\u{23ED}\u{FE0F}")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.volumeUp)
      .setLabel("Plus")
      .setEmoji("\u{1F50A}")
      .setStyle(ButtonStyle.Secondary)
  );

  if (!state.hasPrevious) {
    rowOne.components[1]?.setDisabled(true);
  }

  const rowTwo = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.shuffle)
      .setLabel("Melange")
      .setEmoji("\u{1F500}")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.loop)
      .setLabel(loopLabel)
      .setEmoji("\u{1F501}")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.stop)
      .setLabel("Arret")
      .setEmoji("\u{23F9}\u{FE0F}")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.autoplay)
      .setLabel(autoplayLabel)
      .setEmoji("\u{1F916}")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTONS.playlist)
      .setLabel("File")
      .setEmoji("\u{1F3B6}")
      .setStyle(ButtonStyle.Secondary)
  );

  return [rowOne, rowTwo];
}

export function disablePanelRows(
  rows: ReadonlyArray<{ components: ReadonlyArray<unknown> }>
): ActionRowBuilder<ButtonBuilder>[] {
  const convertedRows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const row of rows) {
    const actionRow = new ActionRowBuilder<ButtonBuilder>();
    for (const component of row.components) {
      if (!isButtonComponent(component)) {
        continue;
      }

      actionRow.addComponents(ButtonBuilder.from(component).setDisabled(true));
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

  const safeStatus = status.replace(/\s+/g, " ").trim().slice(0, 180);
  const builder = EmbedBuilder.from(first).setTimestamp(new Date());
  const baseFooter = "Controles rapides disponibles ci-dessous";
  builder.setFooter({ text: `${baseFooter} | Derniere action: ${safeStatus}`.slice(0, 2048) });
  return [builder];
}

function formatProvider(provider: string): string {
  switch (provider) {
    case "youtube":
      return "YouTube";
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

function escapeTitle(title: string): string {
  return title.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function isButtonComponent(component: unknown): component is Parameters<
  typeof ButtonBuilder.from
>[0] {
  if (!component || typeof component !== "object") {
    return false;
  }

  return (component as { type?: number }).type === 2;
}
