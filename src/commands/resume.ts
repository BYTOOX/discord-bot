import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { ensureDjPermission } from "./utils";

export const resumeCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName("resume").setDescription("Reprend la lecture."),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    await client.musicService.resume(interaction);
    if (interaction.guildId) {
      await client.refreshRegisteredMusicPanel(interaction.guildId, "Lecture reprise.");
    }
    await sendReply(interaction, "Lecture reprise.");
  }
};
