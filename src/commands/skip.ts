import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { displayTrack } from "../modules/music/trackHelpers";
import { ensureDjPermission } from "./utils";

export const skipCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName("skip").setDescription("Passe a la piste suivante."),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    const nextTrack = await client.musicService.skip(interaction);
    if (!nextTrack) {
      await sendReply(interaction, "Piste passee. La file est maintenant vide.");
      return;
    }

    await sendReply(interaction, `Piste passee. En cours: ${displayTrack(nextTrack)}`);
  }
};
