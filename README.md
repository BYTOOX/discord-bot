# Quantum Jukebox

Bot musical Discord orienté **un seul serveur Discord** et prêt pour un déploiement **multi-réplicas** sur une seule machine/infra.

## Positionnement

Quantum Jukebox est construit pour:

- rester simple à opérer en production (Docker Compose)
- rester stable en multi-instance (état partagé + verrous distribués)
- limiter strictement les providers à **YouTube** et **Spotify**
- proposer une expérience visuelle moderne avec un panel interactif

## Fonctionnalités clés

| Domaine | Comportement |
| --- | --- |
| Sources audio | YouTube (prioritaire en recherche texte), Spotify (liens directs) |
| Fallback providers | Désactivé (pas de SoundCloud / Apple / Deezer) |
| Playlists | Import complet des liens playlists, limite d'import à 101 pistes |
| Multi-réplicas | Locks Redis + état partagé PostgreSQL |
| Persistance | Paramètres serveur, playlists custom, registre des panels |
| UI | Panel interactif + image générée côté bot |
| Langue | Messages utilisateur en français |

## Architecture runtime

```text
Discord Gateway/API
        |
        v
+---------------------+
|   quantum-jukebox   |  (N replicas possibles)
| discord.js + logic  |
+----+-----------+----+
     |           |
     |           +--> Redis (locks distribués)
     |
     +--> PostgreSQL (settings, playlists, panels)
     |
     +--> Lavalink v4 (+ youtube-plugin + lavasrc)
                |
                +--> yt-cipher
```

## Stack technique

- `discord.js`
- `lavalink-client`
- Lavalink v4 + `youtube-plugin` + `lavasrc-plugin`
- `@napi-rs/canvas`
- `PostgreSQL`
- `Redis`
- `Docker Compose`

## Prérequis

- Docker + Docker Compose
- Un bot Discord déjà créé
- Le bot invité dans le serveur cible
- Variables Discord valides dans `.env`

## Configuration

Copier l'exemple:

```bash
cp .env.example .env
```

Variables importantes:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `POSTGRES_URL` (défaut fourni)
- `REDIS_URL` (défaut fourni)
- `LAVALINK_PASSWORD`
- `MAX_TRACKS_PER_PLAYLIST` (clampé automatiquement à `101`)

## Démarrage

### Stack complète

```bash
docker compose up -d --build
```

### Vérifier les services

```bash
docker compose ps
docker compose logs --tail=200 bot
```

### Arrêt propre

```bash
docker compose down
```

## Mode multi-réplicas (même serveur)

Exemple avec 3 instances bot:

```bash
docker compose up -d --scale bot=3
```

## Commandes principales

- `/play query:<url|texte>`
- `/queue`
- `/nowplaying`
- `/skip`
- `/stop`
- `/pause`
- `/resume`
- `/panel pin`
- `/panel refresh`
- `/panel unpin`
- `/leave`
- `/volume value:<1-200>`
- `/autoplay [enabled]`
- `/mode247 [enabled]`
- `/filter effect:<reset|nightcore|vaporwave|bassboost|rock>`
- `/playlist create name`
- `/playlist list`
- `/playlist info name`
- `/playlist add name query`
- `/playlist savecurrent name`
- `/playlist savequeue name`
- `/playlist savesession name [limit<=101]`
- `/playlist remove name index`
- `/playlist play name [shuffle]`

## Contrat produit actuel

- Providers autorisés: **YouTube + Spotify uniquement**
- Recherche texte: **YouTube prioritaire**
- Liens externes non supportés: rejet explicite
- Import playlist: max `101` pistes par opération

## Développement local

```bash
npm install
npm run check
npm run build
npm run dev
```

## Dépannage

### `DiscordAPIError[50001]: Missing Access`

Cause fréquente: bot non présent dans le serveur cible, ou mauvais `DISCORD_GUILD_ID`, ou permissions insuffisantes sur l'application.

Vérifier:

- le bot est bien invité dans le serveur
- `DISCORD_GUILD_ID` correspond au bon serveur
- les scopes OAuth2 et permissions Discord sont corrects

### Erreur de connexion PostgreSQL/Redis au boot

Les dépendances peuvent démarrer juste après le bot au premier boot. En mode Compose, la reprise automatique du conteneur bot corrige généralement ce point.
