import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { buildMusicPanel } from "../modules/music/MusicPanel";
import type { ProviderMode } from "../modules/providers/types";
import type { EnqueueResult } from "../modules/music/types";

export const playCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Lance une musique ou une playlist.")
    .addStringOption((option) =>
      option.setName("query").setDescription("URL ou texte de recherche").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("source")
        .setDescription("Source de recherche (ignoree si URL)")
        .addChoices(
          { name: "Automatique", value: "auto" },
          { name: "YouTube Music", value: "youtube_music" },
          { name: "YouTube", value: "youtube" },
          { name: "SoundCloud", value: "soundcloud" },
          { name: "Spotify", value: "spotify" },
          { name: "Apple Music", value: "apple_music" },
          { name: "Deezer", value: "deezer" }
        )
    ),
  async execute(interaction, client) {
    const query = interaction.options.getString("query", true);
    const provider = (interaction.options.getString("source") ?? "auto") as ProviderMode;

    await interaction.deferReply({ ephemeral: true });
    const result = await client.musicService.enqueue(interaction, query, provider);

    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const status = buildEnqueueStatus(result, query, provider);
    const refreshed = await client.refreshRegisteredMusicPanel(interaction.guildId, status);
    if (refreshed) {
      await sendReply(interaction, `Ajoute a la file: ${formatAddedCount(result)}.`);
      return;
    }

    const panelState = await client.musicService.getPanelState(interaction.guildId);
    const panelDisplay = await client.getPanelDisplayOrFallback(interaction.guildId, interaction.user.id);

    const panel = buildMusicPanel(
      panelDisplay,
      client.config.musicPanelEmoji,
      panelState,
      status
    );

    const targetChannel = interaction.channel;
    if (!targetChannel?.isTextBased() || !("send" in targetChannel)) {
      throw new Error("Ce salon ne permet pas d'envoyer le panneau.");
    }

    const sent = await targetChannel.send({
      components: panel.components,
      flags: panel.flags
    });

    client.registerMusicPanelMessage(interaction.guildId, sent.channelId, sent.id);
    await client.refreshRegisteredMusicPanel(interaction.guildId, status);
    await sendReply(interaction, `Ajoute a la file: ${formatAddedCount(result)}.`);
  }
};

function buildPlayModeInfo(query: string, provider: ProviderMode): string {
  if (isUrl(query)) {
    return "URL detectee: selection automatique de la source.";
  }

  if (provider === "auto") {
    return "Recherche texte: source automatique active.";
  }

  return `Recherche texte: source forcee sur ${formatProviderMode(provider)}.`;
}

function buildEnqueueStatus(result: EnqueueResult, query: string, provider: ProviderMode): string {
  const addedInfo = formatAddedCount(result);
  const duplicateInfo =
    result.duplicateSkippedCount > 0
      ? `Doublons ignores: ${result.duplicateSkippedCount}.`
      : "";
  const modeInfo = buildPlayModeInfo(query, provider);
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

function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function formatProviderMode(provider: ProviderMode): string {
  switch (provider) {
    case "youtube":
      return "YouTube";
    case "youtube_music":
      return "YouTube Music";
    case "soundcloud":
      return "SoundCloud";
    case "spotify":
      return "Spotify";
    case "apple_music":
      return "Apple Music";
    case "deezer":
      return "Deezer";
    default:
      return "Automatique";
  }
}
