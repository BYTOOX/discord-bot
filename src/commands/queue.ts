import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { mustGetGuildId } from "./utils";

export const queueCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName("queue").setDescription("Affiche la file actuelle."),
  async execute(interaction, client) {
    const guildId = mustGetGuildId(interaction);
    const queue = client.musicService.getQueueSummary(guildId);

    if (!queue.current && queue.upcoming.length === 0) {
      await sendReply(interaction, "La file est vide.");
      return;
    }

    const parts: string[] = [];
    if (queue.current) {
      parts.push(`En cours: ${queue.current}`);
    } else {
      parts.push("En cours: rien");
    }

    if (queue.upcoming.length > 0) {
      parts.push("", "A suivre:");
      parts.push(...queue.upcoming);
    }

    await sendReply(interaction, parts.join("\n"));
  }
};
