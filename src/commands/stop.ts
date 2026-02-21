import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { ensureDjPermission } from "./utils";

export const stopCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Arrete la lecture et vide la file."),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    await client.musicService.stop(interaction);
    if (interaction.guildId) {
      await client.refreshRegisteredMusicPanel(interaction.guildId, "Lecture arretee et file videe.");
    }
    await sendReply(interaction, "Lecture arretee et file videe.");
  }
};
