import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { ensureDjPermission } from "./utils";

const FILTER_CHOICES = [
  { name: "Aucun", value: "reset" },
  { name: "Nightcore", value: "nightcore" },
  { name: "Vaporwave", value: "vaporwave" },
  { name: "Bassboost", value: "bassboost" },
  { name: "Rock", value: "rock" }
] as const;

export const filterCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("filter")
    .setDescription("Applique un filtre audio.")
    .addStringOption((option) =>
      option
        .setName("effect")
        .setDescription("Profil de filtre")
        .setRequired(true)
        .addChoices(...FILTER_CHOICES)
    ),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    const effect = interaction.options.getString("effect", true) as
      | "reset"
      | "nightcore"
      | "vaporwave"
      | "bassboost"
      | "rock";

    await client.musicService.applyFilter(interaction, effect);
    if (interaction.guildId) {
      await client.refreshRegisteredMusicPanel(interaction.guildId, `Filtre applique: ${effect}.`);
    }
    await sendReply(interaction, `Filtre applique: ${effect}.`);
  }
};
