import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { ensureDjPermission, mustGetGuildId } from "./utils";

export const autoplayCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Active ou desactive l'autoplay sur ce serveur.")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("Definit l'etat explicitement (optionnel)")
    ),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    const guildId = mustGetGuildId(interaction);
    const explicitValue = interaction.options.getBoolean("enabled");
    const result = await client.musicService.setAutoplay(
      guildId,
      explicitValue === null ? undefined : explicitValue
    );

    await client.refreshRegisteredMusicPanel(
      guildId,
      `Lecture auto ${result.enabled ? "activee" : "desactivee"}.`
    );
    await sendReply(interaction, `Lecture auto ${result.enabled ? "activee" : "desactivee"}.`);
  }
};
