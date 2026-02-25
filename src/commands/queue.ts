import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { getAssignedJukeboxTag, mustGetGuildId } from "./utils";

export const queueCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName("queue").setDescription("Affiche la file actuelle."),
  async execute(interaction, client) {
    const guildId = mustGetGuildId(interaction);
    const musicService = client.musicService as unknown as {
      getQueueSummaryForInteraction?: (
        value: typeof interaction,
        previewCount?: number
      ) => Promise<{ current: string | null; upcoming: string[] }>;
      getQueueSummary: (value: string, previewCount?: number) => { current: string | null; upcoming: string[] };
    };
    const queue =
      typeof musicService.getQueueSummaryForInteraction === "function"
        ? await musicService.getQueueSummaryForInteraction(interaction)
        : musicService.getQueueSummary(guildId);
    const jukeboxTag = await getAssignedJukeboxTag(interaction, client);

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

    const header = jukeboxTag.length > 0 ? `Jukebox actif${jukeboxTag}\n` : "";
    await sendReply(interaction, `${header}${parts.join("\n")}`);
  }
};
