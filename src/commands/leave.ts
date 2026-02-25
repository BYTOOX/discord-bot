import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { ensureDjPermission, getAssignedJukeboxTag } from "./utils";

export const leaveCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Deconnecte le bot du vocal."),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    await client.musicService.leave(interaction);
    const jukeboxTag = await getAssignedJukeboxTag(interaction, client);
    await sendReply(interaction, `Bot deconnecte du salon vocal${jukeboxTag}.`);
  }
};
