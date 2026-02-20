import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { ensureDjPermission } from "./utils";

export const pauseCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName("pause").setDescription("Met la lecture en pause."),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    await client.musicService.pause(interaction);
    await sendReply(interaction, "Lecture en pause.");
  }
};
