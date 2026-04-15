# Quantum Jukebox

> Bot musical Discord haut de gamme, pense pour **un seul serveur Discord** avec deux modes de runtime: **solo** ou **1 orchestrateur + pool de jukebox vocaux**.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-22-3C873A?logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Lavalink](https://img.shields.io/badge/Lavalink-v4-111111)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

## Vision

Quantum Jukebox vise un equilibre clair:

- **Experience utilisateur premium**: Command Center interactif + messages de session par jukebox.
- **Fiabilite production**: etat partage, verrous distribues, coordination inter-processus.
- **Simplicite d'exploitation**: stack Docker Compose unique.
- **Coherence produit**: YouTube + Spotify uniquement, messages en francais.
- **Orchestration multi-bots**: 1 orchestrateur + pool de jukebox vocaux distincts.

## Caracteristiques cles

| Axe | Decision produit |
| --- | --- |
| Runtime bots | **1 bot unique** ou **1 orchestrateur + N jukebox** (N>=3 recommande) |
| Sources audio | **YouTube** et **Spotify** uniquement |
| Priorite recherche texte | YouTube |
| Liens directs | Spotify resolu via Lavalink/LavaSrc sans mirroring YouTube, YouTube accepte |
| Providers non supportes | Rejet explicite (pas de fallback SoundCloud/Apple/Deezer) |
| Imports multi-pistes | Import complet, plafond de securite a **101** pistes par import |
| Deploiement | Une seule infra Docker Compose |
| Persistance | PostgreSQL |
| Coordination runtime | Redis (locks distribues + synchronisation) |
| Langue | Francais |

## Demarrage ultra rapide

1. Copier la configuration:

```bash
cp .env.example .env
```

2. Renseigner au minimum dans `.env`:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`

3. Lancer la stack complete:

```bash
docker compose up -d --build
```

4. Verifier:

```bash
docker compose ps
docker compose logs --tail=200 bot
```

5. Arret propre:

```bash
docker compose down
```

## Architecture

```mermaid
flowchart LR
    D[Discord Gateway/API] --> O[Orchestrateur\nslash commands + Command Center]
    O --> J1[Jukebox #1]
    O --> J2[Jukebox #2]
    O --> J3[Jukebox #3]
    O --> R[(Redis\nlocks distribues)]
    O --> P[(PostgreSQL\nsettings + panels)]
    J1 --> L[Lavalink v4\nyoutube-plugin + lavasrc]
    J2 --> L
    J3 --> L
    L --> C[remoteCipher\n(public ou self-hosted)]
```

## Modes de runtime

### Mode solo

- Si `JUKEBOX_TOKENS` est vide, l'application demarre en **bot unique**.
- Ce mode convient si un seul flux vocal simultane suffit.

### Mode orchestrateur + jukebox

- Si `JUKEBOX_TOKENS` contient **au moins 3 tokens**, l'application demarre en **1 orchestrateur + N jukebox**.
- L'orchestrateur publie et traite les slash commands.
- Les jukebox n'exposent pas de slash commands, restent invisibles, et servent uniquement au runtime vocal.
- Le routing est **channel-bound**: un jukebox reste attache a son salon jusqu'a deconnexion.
- Redis evite le double traitement et maintient la coherence des affectations.

### A propos du `--scale bot=N`

- `docker compose up -d --scale bot=3` avec **le meme token** ajoute de la redondance de process, pas de la concurrence vocale.
- Un seul token Discord reste une seule identite: cela n'augmente pas le nombre de salons vocaux simultanes.
- Pour jouer plusieurs musiques en parallele dans plusieurs salons, il faut le mode **orchestrateur + jukebox**.

## Configuration (variables importantes)

| Variable | Requis | Defaut | Description |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Oui | - | Token du bot Discord orchestrateur (ou du bot unique en mode solo) |
| `DISCORD_CLIENT_ID` | Oui | - | ID application Discord de l'orchestrateur |
| `DISCORD_GUILD_ID` | Oui | - | ID du serveur Discord cible |
| `JUKEBOX_TOKENS` | Non | vide | CSV de tokens jukebox. Vide = mode solo, sinon active le mode orchestrateur (minimum 3 tokens) |
| `JUKEBOX_FIXED_NAMES` | Non | vide | CSV de pseudos forces pour les jukebox. Si vide, des noms humoristiques sont tires aleatoirement |
| `POSTGRES_URL` | Non | `postgresql://quantum:quantum@postgres:5432/quantum_jukebox` | Connexion PostgreSQL sur le reseau Docker Compose |
| `REDIS_URL` | Non | `redis://redis:6379` | Connexion Redis sur le reseau Docker Compose |
| `LAVALINK_HOST` | Non | `lavalink` | Hote Lavalink sur le reseau Docker Compose |
| `LAVALINK_PORT` | Non | `2333` | Port Lavalink |
| `LAVALINK_PASSWORD` | Non | `youshallnotpass` | Mot de passe Lavalink |
| `LAVALINK_SECURE` | Non | `false` | Active `wss/https` vers Lavalink |
| `YOUTUBE_OAUTH_ENABLED` | Non | `false` | Active OAuth youtube-plugin (recommande en production) |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | Non | vide | Refresh token OAuth YouTube (optionnel au premier demarrage) |
| `YOUTUBE_OAUTH_SKIP_INITIALIZATION` | Non | `false` | Skip de l'init OAuth auto au boot Lavalink |
| `YOUTUBE_REMOTE_CIPHER_URL` | Non | `https://cipher.kikkia.dev/` | Endpoint remote cipher YouTube |
| `YOUTUBE_REMOTE_CIPHER_USER_AGENT` | Non | `quantum-jukebox` | User-Agent envoye au remote cipher |
| `MUSIC_CONTROL_CHANNEL_ID` | Non | vide | Salon texte dedie au Command Center musique |
| `DJ_ROLE_IDS` | Non | vide | IDs de roles DJ autorises (CSV) |
| `COMMAND_CENTER_ROLE_IDS` | Non | vide | IDs de roles autorises a gerer le Command Center (slash + boutons) |
| `DEFAULT_VOLUME` | Non | `80` | Volume par defaut |
| `PLAYER_EMPTY_TIMEOUT_MS` | Non | `300000` | Timeout avant deconnexion auto d'un player vide |
| `PLAYER_SELF_DEAF` | Non | `true` | Active l'auto-deafen du bot en vocal |
| `AUTOPLAY_DEFAULT` | Non | `false` | Valeur par defaut du mode autoplay |
| `STAY_IN_VOICE_DEFAULT` | Non | `false` | Valeur par defaut du mode 24/7 |
| `SPOTIFY_CLIENT_ID` | Non | vide | Client ID Spotify pour LavaSrc cote Lavalink |
| `SPOTIFY_CLIENT_SECRET` | Non | vide | Client Secret Spotify pour LavaSrc cote Lavalink |

## Commandes utilisateur

- `/ping`

### Lecture

- `/play query:<url|texte>`
- `/queue`
- `/nowplaying`
- `/skip`
- `/stop`
- `/pause`
- `/resume`
- `/leave`
- `/volume value:<1-200>`
- `/filter effect:<reset|nightcore|vaporwave|bassboost|rock>`
- URLs de playlists YouTube/Spotify: acceptees via `/play` (max `101` pistes par ajout)

### Comportement serveur

- `/autoplay [enabled]`
- `/mode247 [enabled]`

### Command Center

Le panel legacy n'est plus utilise.
`/panel` pilote maintenant le `Command Center` global.

- Si `MUSIC_CONTROL_CHANNEL_ID` est configure, le bot maintient automatiquement un message global dans ce salon.
- Des messages de session par jukebox sont egalement maintenus pour les lectures actives.
- Les memes actions sont disponibles via les boutons du `Command Center`.
- Les roles filtres par `COMMAND_CENTER_ROLE_IDS` controlent l'acces a ces actions.

- `/panel refresh`
- `/panel rebuild`
- `/panel clean`

## Contrat fonctionnel

- Recherche texte: **YouTube prioritaire**.
- Spotify: accepte via **liens directs** resolus par Lavalink/LavaSrc, sans fallback YouTube manuel dans le bot ni mirroring YouTube cote LavaSrc.
- Spotify exige une source directe non-YouTube cote LavaSrc pour etre jouable (par ex. Deezer). Sans cela, le bot echoue explicitement.
- Import de playlists externes: max `101` pistes par operation.
- Sources non supportees: erreur explicite, en francais.
- Routing vocal: **1 jukebox max par salon vocal** et **1 salon max par jukebox**.
- Binding: un jukebox reste attache au salon jusqu'a deconnexion.
- Allocation: **premier jukebox libre**.
- Saturation: si tous les jukebox sont occupes, l'orchestrateur renvoie une alerte explicite.
- Reprise: un failover best-effort tente de basculer vers un autre jukebox en cas de panne runtime.

## Exploitation

### Monter a plusieurs replicas (mode bot unique, haute disponibilite)

```bash
docker compose up -d --scale bot=3
```

Important:

- ce mode ne fournit pas plusieurs bots vocaux,
- il renforce seulement la disponibilite d'un bot unique partageant le meme token.

### Mode orchestrateur + 3 jukebox

1. Creer et inviter 4 applications Discord sur le meme serveur (1 orchestrateur + 3 jukebox minimum).
2. Renseigner:
   - `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` pour l'orchestrateur
   - `JUKEBOX_TOKENS=token_1,token_2,token_3` (minimum 3)
   - `JUKEBOX_FIXED_NAMES=nom_1,nom_2,nom_3` si tu veux forcer les pseudos
   - `MUSIC_CONTROL_CHANNEL_ID` si tu veux activer le Command Center persistant
3. Lancer normalement:

```bash
docker compose up -d --build
```

Important:

- les jukebox doivent etre presents sur le serveur (`guildCount > 0` dans les logs),
- les commandes slash restent publiees uniquement par l'orchestrateur,
- les jukebox n'exposent pas de slash commands et servent uniquement au voice runtime,
- donne `Manage Nicknames` + une hierarchie de role correcte si tu veux autoriser le renommage automatique.

### Logs live

```bash
docker compose logs -f bot
```

Signaux utiles dans les logs:

- `Mode orchestrateur actif: routing channel-bound vers pool jukebox`
- `Noeud Lavalink connecte`
- `Failover jukebox applique apres erreur`

### Rebuild apres mise a jour

```bash
docker compose down
docker compose up -d --build
```

## Developpement local

```bash
npm install
npm run check
npm run build
npm run dev
```

## Depannage rapide

### `DiscordAPIError[50001]: Missing Access`

Causes typiques:

- bot non present dans le serveur cible
- mauvais `DISCORD_GUILD_ID`
- permissions/scopes OAuth2 Discord incomplets

### `DiscordAPIError[50013]: Missing Permissions`

Causes typiques:

- l'orchestrateur n'a pas assez de droits pour renommer un jukebox (`setNickname`)
- le role du bot est trop bas dans la hierarchie

Impact:

- non bloquant pour la lecture
- les pseudos automatiques des jukebox peuvent ne pas s'appliquer

### Erreur PostgreSQL/Redis au tout premier boot

Le bot peut demarrer avant les dependances. Avec `restart: unless-stopped`, il repart automatiquement des que Postgres/Redis repondent.

### `exec /app/server: exec format error` sur `yt-cipher`

Cause typique:

- image `ghcr.io/kikkia/yt-cipher:master` publiee avec un binaire `/app/server` invalide

Resolution:

- basculer sur `remoteCipher` via `YOUTUBE_REMOTE_CIPHER_URL` (defaut: `https://cipher.kikkia.dev/`)
- supprimer le service `yt-cipher` local de la stack le temps qu'un tag image sain soit republie

### Lecture YouTube annoncee mais sans son

Si Lavalink remonte `Sign in to confirm you're not a bot` ou des erreurs de codec non audio:

- activer `YOUTUBE_OAUTH_ENABLED=true`
- injecter ensuite `YOUTUBE_OAUTH_REFRESH_TOKEN` (persistant)
- redemarrer la stack (`docker compose down && docker compose up -d --build`)
- valider avec la lecture Discord standard (`/play`), pas via un endpoint REST `youtube/stream`

## Arborescence utile

```text
src/
  commands/                  commandes slash
  config/                    lecture et validation de la config env
  core/                      client Discord + orchestration
  modules/infrastructure/    PostgreSQL + Redis locks
  modules/music/             playback, command center, settings, lavalink
  modules/orchestrator/      allocation channel-bound et pool jukebox
  modules/providers/         resolution des providers (YouTube/Spotify)
```
