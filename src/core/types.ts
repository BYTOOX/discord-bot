import type { ChatInputCommandInteraction } from "discord.js";

import type { QuantumClient } from "./QuantumClient";

interface SlashCommandData {
  name: string;
  toJSON(): object;
}

export interface SlashCommand {
  data: SlashCommandData;
  execute(interaction: ChatInputCommandInteraction, client: QuantumClient): Promise<void>;
}
