import type {
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  InteractionReplyOptions
} from "discord.js";
import { MessageFlags } from "discord.js";

type ReplyPayload = string | InteractionReplyOptions;

function normalizePayload(payload: ReplyPayload): InteractionReplyOptions {
  if (typeof payload === "string") {
    return { content: payload };
  }

  const { ephemeral, flags, ...rest } = payload;
  if (typeof ephemeral !== "boolean") {
    return payload;
  }

  if (!ephemeral) {
    return {
      ...rest,
      ...(flags === undefined ? {} : { flags })
    };
  }

  if (flags === undefined) {
    return {
      ...rest,
      flags: MessageFlags.Ephemeral
    };
  }

  if (typeof flags === "number") {
    return {
      ...rest,
      flags: flags | MessageFlags.Ephemeral
    };
  }

  if (typeof flags === "bigint") {
    return {
      ...rest,
      flags: Number(flags | BigInt(MessageFlags.Ephemeral))
    };
  }

  const mergedFlags = Array.isArray(flags)
    ? [...flags, MessageFlags.Ephemeral]
    : [flags, MessageFlags.Ephemeral];

  return {
    ...rest,
    flags: mergedFlags as InteractionReplyOptions["flags"]
  };
}

export async function sendReply(
  interaction: ChatInputCommandInteraction,
  payload: ReplyPayload
): Promise<void> {
  const options = normalizePayload(payload);

  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply(options as InteractionEditReplyOptions);
    return;
  }

  if (interaction.replied) {
    await interaction.followUp(options);
    return;
  }

  await interaction.reply(options);
}

