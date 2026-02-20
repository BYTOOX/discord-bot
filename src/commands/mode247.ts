import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { ensureDjPermission, mustGetGuildId } from "./utils";

export const mode247Command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("mode247")
    .setDescription("Active ou desactive le mode vocal 24/7 sur ce serveur.")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("Definit l'etat explicitement (optionnel)")
    ),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    const guildId = mustGetGuildId(interaction);
    const explicitValue = interaction.options.getBoolean("enabled");
    const result = await client.musicService.setStayInVoice(
      guildId,
      explicitValue === null ? undefined : explicitValue
    );

    await sendReply(interaction, `Mode 24/7 ${result.enabled ? "active" : "desactive"}.`);
  }
};
