import { MessageFlags, SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { buildMusicPanel } from "../modules/music/MusicPanel";
import type { EnqueueResult } from "../modules/music/types";
import { getAssignedJukeboxTag } from "./utils";

export const playCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Lance une musique ou une playlist YouTube/Spotify.")
    .addStringOption((option) =>
      option.setName("query").setDescription("URL YouTube/Spotify ou texte").setRequired(true)
    ),
  async execute(interaction, client) {
    const query = interaction.options.getString("query", true);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await client.musicService.enqueue(interaction, query);
    const jukeboxTag = await getAssignedJukeboxTag(interaction, client);

    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const status = buildEnqueueStatus(result, query);
    const refreshed = await client.refreshRegisteredMusicPanel(interaction.guildId, status);
    if (refreshed) {
      await sendReply(interaction, `Ajoute a la file${jukeboxTag}: ${formatAddedCount(result)}.`);
      return;
    }

    const panelState = await client.musicService.getPanelState(interaction.guildId);
    const panelDisplay = await client.getPanelDisplayOrFallback(interaction.guildId, interaction.user.id);

    const panel = buildMusicPanel(panelDisplay, client.config.musicPanelEmoji, panelState, status);

    const targetChannel = interaction.channel;
    if (!targetChannel?.isTextBased() || !("send" in targetChannel)) {
      throw new Error("Ce salon ne permet pas d'envoyer le panneau.");
    }

    const sent = await targetChannel.send({
      components: panel.components,
      flags: panel.flags
    });

    await client.registerMusicPanelMessage(interaction.guildId, sent.channelId, sent.id);
    await client.refreshRegisteredMusicPanel(interaction.guildId, status);
    await sendReply(interaction, `Ajoute a la file${jukeboxTag}: ${formatAddedCount(result)}.`);
  }
};

function buildPlayModeInfo(query: string): string {
  if (/spotify\.com\//i.test(query)) {
    return "Lien Spotify detecte: lecture via resolution Spotify.";
  }

  if (/(youtube\.com|youtu\.be)/i.test(query)) {
    return "Lien YouTube detecte.";
  }

  return "Recherche texte: YouTube prioritaire.";
}

function buildEnqueueStatus(result: EnqueueResult, query: string): string {
  const addedInfo = formatAddedCount(result);
  const duplicateInfo =
    result.duplicateSkippedCount > 0
      ? `Doublons ignores: ${result.duplicateSkippedCount}.`
      : "";
  const modeInfo = buildPlayModeInfo(query);
  const playlistInfo = result.playlistName ? `Playlist detectee: ${result.playlistName}.` : "";
  return [addedInfo, duplicateInfo, playlistInfo, modeInfo]
    .filter((part) => part.length > 0)
    .join(" ");
}

function formatAddedCount(result: EnqueueResult): string {
  if (result.isPlaylist) {
    return `${result.addedCount} piste(s) ajoutee(s)`;
  }

  return `+${result.addedCount} piste ajoutee`;
}


