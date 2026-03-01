import { MessageFlags, SlashCommandBuilder } from "discord.js";

import type { SlashCommand } from "../core/types";
import { sendReply } from "../core/interactionReply";
import { ensureCommandCenterPermission, mustGetGuildId } from "./utils";

export const panelCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Gere le command center musique.")
    .addSubcommand((subcommand) =>
      subcommand.setName("refresh").setDescription("Force une synchronisation du command center.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("rebuild").setDescription("Reposte proprement le command center.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("clean").setDescription("Nettoie le salon musique puis reposte le command center.")
    ),
  async execute(interaction, client) {
    if (!(await ensureCommandCenterPermission(interaction, client))) {
      return;
    }

    const guildId = mustGetGuildId(interaction);
    const subcommand = interaction.options.getSubcommand(true);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (subcommand) {
      case "refresh":
        await client.refreshRegisteredMusicPanel(guildId, "Refresh manuel.");
        await sendReply(interaction, {
          content: "Command center synchronise.",
          flags: MessageFlags.Ephemeral
        });
        return;
      case "rebuild":
        await client.forceRebuildMusicControlSurface(guildId);
        await sendReply(interaction, {
          content: "Command center reconstruit.",
          flags: MessageFlags.Ephemeral
        });
        return;
      case "clean":
        await client.cleanMusicControlSurface(guildId);
        await sendReply(interaction, {
          content: "Salon musique nettoye et command center reposte.",
          flags: MessageFlags.Ephemeral
        });
        return;
      default:
        throw new Error("Sous-commande panel inconnue.");
    }
  }
};
