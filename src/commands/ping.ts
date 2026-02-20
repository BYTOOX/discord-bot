import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";

export const pingCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName("ping").setDescription("Verifie la latence du bot."),
  async execute(interaction, client) {
    const gatewayPing = client.ws.ping;
    await sendReply(interaction, `Pong. Latence passerelle: ${gatewayPing}ms`);
  }
};
