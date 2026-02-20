import type { ChatInputCommandInteraction } from "discord.js";

import type { QuantumClient } from "../core/QuantumClient";
import { sendReply } from "../core/interactionReply";

export async function ensureDjPermission(
  interaction: ChatInputCommandInteraction,
  client: QuantumClient
): Promise<boolean> {
  const member = await client.musicService.fetchMember(interaction);
  if (client.accessPolicy.canManagePlayback(member)) {
    return true;
  }

  await sendReply(interaction, {
    content: "Il faut un role DJ ou la permission Gerer le serveur pour cette commande.",
    ephemeral: true
  });
  return false;
}

export function mustGetGuildId(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    throw new Error("Cette commande fonctionne uniquement sur un serveur.");
  }
  return interaction.guildId;
}
