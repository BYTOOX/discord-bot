import { MessageFlags, SlashCommandBuilder } from "discord.js";

import type { SlashCommand } from "../core/types";
import { sendReply } from "../core/interactionReply";
import { buildMusicPanel, disablePanelRows } from "../modules/music/MusicPanel";
import { ensureDjPermission, mustGetGuildId } from "./utils";

export const panelCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Gere le panneau musique dynamique.")
    .addSubcommand((subcommand) =>
      subcommand.setName("pin").setDescription("Epingle un panneau musique moderne dans ce salon.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("refresh").setDescription("Force un rafraichissement du panneau epingle.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("unpin").setDescription("Retire le panneau epingle pour ce serveur.")
    ),
  async execute(interaction, client) {
    if (!(await ensureDjPermission(interaction, client))) {
      return;
    }

    const guildId = mustGetGuildId(interaction);
    const subcommand = interaction.options.getSubcommand(true);

    switch (subcommand) {
      case "pin": {
        const targetChannel = interaction.channel;
        if (!targetChannel?.isTextBased() || !("send" in targetChannel)) {
          throw new Error("Ce salon ne permet pas d'envoyer un panneau.");
        }

        await interaction.deferReply({ ephemeral: true });

        const previous = client.getRegisteredMusicPanel(guildId);
        const panelState = await client.musicService.getPanelState(guildId);
        const panelDisplay = await client.getPanelDisplayOrFallback(guildId, interaction.user.id);
        const panel = buildMusicPanel(
          panelDisplay,
          client.config.musicPanelEmoji,
          panelState,
          "Panel epingle."
        );

        const sent = await targetChannel.send({
          components: panel.components,
          flags: panel.flags
        });
        client.registerMusicPanelMessage(guildId, sent.channelId, sent.id);

        if (
          previous &&
          (previous.channelId !== sent.channelId || previous.messageId !== sent.id)
        ) {
          await disablePanelMessage(client, previous.channelId, previous.messageId, "Panel deplace.");
        }

        await client.refreshRegisteredMusicPanel(guildId, "Panel epingle.");
        await sendReply(interaction, {
          content: `Panel epingle dans <#${sent.channelId}>.`,
          ephemeral: true
        });
        return;
      }

      case "refresh": {
        const refreshed = await client.refreshRegisteredMusicPanel(
          guildId,
          "Rafraichissement manuel."
        );
        if (!refreshed) {
          await sendReply(interaction, {
            content: "Aucun panneau epingle. Utilise `/panel pin`.",
            ephemeral: true
          });
          return;
        }

        await sendReply(interaction, {
          content: "Panel rafraichi.",
          ephemeral: true
        });
        return;
      }

      case "unpin": {
        const current = client.getRegisteredMusicPanel(guildId);
        if (!current) {
          await sendReply(interaction, {
            content: "Aucun panneau epingle pour ce serveur.",
            ephemeral: true
          });
          return;
        }

        client.clearRegisteredMusicPanel(guildId);
        await disablePanelMessage(client, current.channelId, current.messageId, "Panel desepingle.");
        await sendReply(interaction, {
          content: "Panel desepingle.",
          ephemeral: true
        });
        return;
      }

      default:
        throw new Error("Sous-commande panel inconnue.");
    }
  }
};

async function disablePanelMessage(
  client: {
    channels: { fetch(id: string): Promise<unknown> };
    logger: { debug(payload: unknown, msg: string): void };
  },
  channelId: string,
  messageId: string,
  reason: string
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel !== "object" || !("isTextBased" in channel)) {
      return;
    }

    if (!(channel as { isTextBased(): boolean }).isTextBased() || !("messages" in channel)) {
      return;
    }

    const textChannel = channel as {
      messages: { fetch(id: string): Promise<{ components: unknown[]; embeds: unknown[]; edit(payload: unknown): Promise<unknown> }> };
    };
    const message = await textChannel.messages.fetch(messageId);
    const rows = extractButtonRows(message.components as ReadonlyArray<{ toJSON(): { type: number; components?: unknown[] } }>);
    await message.edit({
      components: disablePanelRows(rows),
      flags: MessageFlags.IsComponentsV2,
      content: `Panel inactif: ${reason}`
    });
  } catch (error) {
    client.logger.debug({ err: error, channelId, messageId }, "Impossible de desactiver l'ancien panel");
  }
}

function extractButtonRows(
  rows: ReadonlyArray<{ toJSON(): { type: number; components?: unknown[] } }>
): Array<{ components: ReadonlyArray<unknown> }> {
  return rows
    .map((row) => row.toJSON())
    .filter((component) => component.type === 1 && Array.isArray(component.components))
    .map((component) => ({
      components: component.components ?? []
    }));
}
