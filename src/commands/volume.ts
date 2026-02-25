import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { ensureDjPermission, getAssignedJukeboxTag } from "./utils";

export const volumeCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Definit le volume de sortie.")
    .addIntegerOption((option) =>
      option
        .setName("value")
        .setDescription("Volume entre 1 et 200")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(200)
    ),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    const value = interaction.options.getInteger("value", true);
    const volume = await client.musicService.setVolume(interaction, value);
    const jukeboxTag = await getAssignedJukeboxTag(interaction, client);
    if (interaction.guildId) {
      await client.refreshRegisteredMusicPanel(interaction.guildId, `Volume regle a ${volume}%.`);
    }
    await sendReply(interaction, `Volume regle a ${volume}%${jukeboxTag}.`);
  }
};
