import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { mustGetGuildId } from "./utils";

export const nowPlayingCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Affiche la musique en cours."),
  async execute(interaction, client) {
    const guildId = mustGetGuildId(interaction);
    const nowPlaying = client.musicService.getNowPlaying(guildId);
    await sendReply(interaction, nowPlaying ? `En cours: ${nowPlaying}` : "Aucune lecture en cours.");
  }
};
