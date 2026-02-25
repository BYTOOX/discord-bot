import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { getAssignedJukeboxTag, mustGetGuildId } from "./utils";

export const nowPlayingCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Affiche la musique en cours."),
  async execute(interaction, client) {
    const guildId = mustGetGuildId(interaction);
    const musicService = client.musicService as unknown as {
      getNowPlayingForInteraction?: (value: typeof interaction) => Promise<string | null>;
      getNowPlaying: (value: string) => string | null;
    };
    const nowPlaying =
      typeof musicService.getNowPlayingForInteraction === "function"
        ? await musicService.getNowPlayingForInteraction(interaction)
        : musicService.getNowPlaying(guildId);
    const jukeboxTag = await getAssignedJukeboxTag(interaction, client);
    await sendReply(
      interaction,
      nowPlaying
        ? `En cours${jukeboxTag}: ${nowPlaying}`
        : `Aucune lecture en cours${jukeboxTag}.`
    );
  }
};
