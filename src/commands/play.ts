import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { buildPlayPanel } from "../modules/music/MusicPanel";
import type { ProviderMode } from "../modules/providers/types";

export const playCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Lance une musique ou une playlist.")
    .addStringOption((option) =>
      option.setName("query").setDescription("URL ou texte de recherche").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("Provider de recherche (ignore si URL)")
        .addChoices(
          { name: "Auto", value: "auto" },
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
    const provider = (interaction.options.getString("provider") ?? "auto") as ProviderMode;

    await interaction.deferReply();
    const result = await client.musicService.enqueue(interaction, query, provider);

    if (!interaction.guildId) {
      throw new Error("Cette commande ne fonctionne que sur un serveur.");
    }

    const panelState = await client.musicService.getPanelState(interaction.guildId);
    const panel = buildPlayPanel(
      result,
      interaction.user.id,
      client.config.musicPanelEmoji,
      panelState
    );
    const modeInfo = buildPlayModeInfo(query, provider);

    const summary = result.isPlaylist
      ? `Playlist ajoutee: ${result.addedCount} piste(s).`
      : `Ajoute a la file: ${result.firstTrackTitle}.`;

    await sendReply(interaction, {
      content: `${summary}\n${modeInfo}`,
      embeds: [panel.embed],
      components: panel.components
    });
  }
};

function buildPlayModeInfo(query: string, provider: ProviderMode): string {
  if (isUrl(query)) {
    return "URL detectee: selection automatique de la source.";
  }

  if (provider === "auto") {
    return "Recherche texte: provider automatique actif.";
  }

  return `Recherche texte: provider force sur ${formatProviderMode(provider)}.`;
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
      return "Auto";
  }
}
