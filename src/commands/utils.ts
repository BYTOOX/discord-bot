import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

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
    flags: MessageFlags.Ephemeral
  });
  return false;
}

export async function ensureCommandCenterPermission(
  interaction: ChatInputCommandInteraction,
  client: QuantumClient
): Promise<boolean> {
  const member = await client.musicService.fetchMember(interaction);
  if (client.accessPolicy.canManageCommandCenter(member)) {
    return true;
  }

  await sendReply(interaction, {
    content: "Il faut le role command center ou la permission Gerer le serveur pour cette commande.",
    flags: MessageFlags.Ephemeral
  });
  return false;
}

export function mustGetGuildId(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    throw new Error("Cette commande fonctionne uniquement sur un serveur.");
  }
  return interaction.guildId;
}

export async function getAssignedJukeboxTag(
  interaction: ChatInputCommandInteraction,
  client: QuantumClient
): Promise<string> {
  const musicService = client.musicService as unknown as {
    describeAssignedJukebox?: (value: ChatInputCommandInteraction) => Promise<string | null>;
  };
  if (typeof musicService.describeAssignedJukebox !== "function") {
    return "";
  }

  const callsign = await musicService.describeAssignedJukebox(interaction);
  return callsign ? ` [${callsign}]` : "";
}

