import { SlashCommandBuilder } from "discord.js";

import { sendReply } from "../core/interactionReply";
import type { SlashCommand } from "../core/types";
import { displayTrack } from "../modules/music/trackHelpers";
import { mustGetGuildId } from "./utils";

export const playlistCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Gere les playlists personnalisees.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Cree une playlist personnalisee.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Nom de la playlist").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("list").setDescription("Affiche les playlists du serveur.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("info")
        .setDescription("Affiche le detail d'une playlist.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Nom de la playlist").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Ajoute une requete/URL dans une playlist.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Nom de la playlist").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("query").setDescription("Requete piste ou URL").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("savecurrent")
        .setDescription("Sauvegarde la piste en cours dans une playlist.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Nom de la playlist").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("savequeue")
        .setDescription("Sauvegarde la file actuelle dans une playlist.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Nom de la playlist").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Supprime une piste de playlist par index.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Nom de la playlist").setRequired(true)
        )
        .addIntegerOption((option) =>
          option
            .setName("index")
            .setDescription("Index de piste depuis /playlist info")
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("play")
        .setDescription("Lance une playlist personnalisee sauvegardee.")
        .addStringOption((option) =>
          option.setName("name").setDescription("Nom de la playlist").setRequired(true)
        )
        .addBooleanOption((option) =>
          option.setName("shuffle").setDescription("Melanger avant ajout")
        )
    ),
  async execute(interaction, client) {
    const guildId = mustGetGuildId(interaction);
    const subcommand = interaction.options.getSubcommand(true);

    switch (subcommand) {
      case "create": {
        const name = interaction.options.getString("name", true);
        const playlist = await client.playlistService.createPlaylist(
          guildId,
          name,
          interaction.user.id
        );
        await sendReply(interaction, `Playlist creee: ${playlist.name}`);
        return;
      }

      case "list": {
        const playlists = await client.playlistService.listPlaylists(guildId);
        if (playlists.length === 0) {
          await sendReply(interaction, "Aucune playlist personnalisee pour le moment.");
          return;
        }

        const lines = playlists
          .slice(0, 25)
          .map((playlist, index) => `${index + 1}. ${playlist.name} (${playlist.tracks.length} pistes)`);
        await sendReply(interaction, [`Playlists personnalisees (${playlists.length}):`, ...lines].join("\n"));
        return;
      }

      case "info": {
        const name = interaction.options.getString("name", true);
        const playlist = await client.playlistService.getPlaylist(guildId, name);
        if (!playlist) {
          throw new Error(`Playlist "${name}" introuvable.`);
        }

        const preview = playlist.tracks
          .slice(0, 15)
          .map((track, index) => `${index + 1}. ${track.title}`);

        const lines = [
          `Playlist: ${playlist.name}`,
          `Pistes: ${playlist.tracks.length}`,
          `Mise a jour: ${new Date(playlist.updatedAt).toLocaleString("fr-FR")}`,
          ""
        ];

        if (preview.length === 0) {
          lines.push("Cette playlist est vide.");
        } else {
          lines.push("Apercu:");
          lines.push(...preview);
        }

        await sendReply(interaction, lines.join("\n"));
        return;
      }

      case "add": {
        const name = interaction.options.getString("name", true);
        const query = interaction.options.getString("query", true);
        const playlist = await client.playlistService.addTrack(guildId, name, {
          query,
          title: query,
          addedBy: interaction.user.id
        });
        await sendReply(
          interaction,
          `Requete ajoutee a "${playlist.name}". Total: ${playlist.tracks.length} pistes.`
        );
        return;
      }

      case "savecurrent": {
        const name = interaction.options.getString("name", true);
        const track = await client.musicService.saveCurrentTrackToPlaylist(interaction, name);
        await sendReply(
          interaction,
          `Piste en cours sauvegardee dans "${name}": ${displayTrack(track)}`
        );
        return;
      }

      case "savequeue": {
        const name = interaction.options.getString("name", true);
        const result = await client.musicService.saveQueueToPlaylist(interaction, name);
        await sendReply(
          interaction,
          `File sauvegardee dans "${name}". Ajoute: ${result.addedCount}/${result.attemptedCount} pistes.`
        );
        return;
      }

      case "remove": {
        const name = interaction.options.getString("name", true);
        const index = interaction.options.getInteger("index", true);
        const result = await client.playlistService.removeTrack(guildId, name, index);
        await sendReply(
          interaction,
          `Piste #${index} supprimee de "${result.playlist.name}": ${result.removed.title}`
        );
        return;
      }

      case "play": {
        const name = interaction.options.getString("name", true);
        const shuffle = interaction.options.getBoolean("shuffle") ?? false;
        await interaction.deferReply();
        const result = await client.musicService.playCustomPlaylist(interaction, name, shuffle);
        await sendReply(
          interaction,
          `Playlist "${name}" ajoutee a la file: ${result.addedCount}/${result.requestedCount} pistes.`
        );
        return;
      }

      default:
        throw new Error("Sous-commande playlist inconnue.");
    }
  }
};
