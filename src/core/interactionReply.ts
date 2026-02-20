import type {
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  InteractionReplyOptions
} from "discord.js";

type ReplyPayload = string | InteractionReplyOptions;

function normalizePayload(payload: ReplyPayload): InteractionReplyOptions {
  if (typeof payload === "string") {
    return { content: payload };
  }

  return payload;
}

export async function sendReply(
  interaction: ChatInputCommandInteraction,
  payload: ReplyPayload
): Promise<void> {
  const options = normalizePayload(payload);

  if (interaction.deferred && !interaction.replied) {
    const { ephemeral: _ephemeral, ...editOptions } = options;
    await interaction.editReply(editOptions as InteractionEditReplyOptions);
    return;
  }

  if (interaction.replied) {
    await interaction.followUp(options);
    return;
  }

  await interaction.reply(options);
}

