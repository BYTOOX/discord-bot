import { REST, Routes } from "discord.js";
import type { Logger } from "pino";

import type { AppConfig } from "../config/env";
import type { SlashCommand } from "./types";

export class CommandRegistry {
  private readonly restClient: REST;
  private commands: SlashCommand[] = [];

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.restClient = new REST({ version: "10" }).setToken(config.discordToken);
  }

  public setCommands(commands: SlashCommand[]): void {
    this.commands = commands;
  }

  public async publish(): Promise<void> {
    if (this.commands.length === 0) {
      return;
    }

    const body = this.commands.map((command) => command.data.toJSON());

    await this.restClient.put(
      Routes.applicationGuildCommands(this.config.discordClientId, this.config.discordGuildId),
      { body }
    );
    this.logger.info(
      { guildId: this.config.discordGuildId, count: body.length },
      "Slash commands published to guild"
    );
  }
}
