# Quantum Jukebox

> Bot musical Discord haut de gamme, pensé pour **un seul serveur Discord** avec déploiement **multi-réplicas** stable sur une seule infra.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-22-3C873A?logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Lavalink](https://img.shields.io/badge/Lavalink-v4-111111)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

## Vision

Quantum Jukebox vise un équilibre clair:

- **Expérience utilisateur premium**: panel interactif moderne + rendu image dynamique.
- **Fiabilité production**: état partagé, verrous distribués, exécution multi-réplicas.
- **Simplicité d'exploitation**: stack Docker Compose unique.
- **Cohérence produit**: YouTube + Spotify uniquement, messages en français.

## Caractéristiques clés

| Axe | Décision produit |
| --- | --- |
| Sources audio | **YouTube** et **Spotify** uniquement |
| Priorité recherche texte | YouTube |
| Liens directs | Spotify accepté, YouTube accepté |
| Providers non supportés | Rejet explicite (pas de fallback SoundCloud/Apple/Deezer) |
| Playlists | Import complet, plafond de sécurité à **101** pistes par import |
| Déploiement | Multi-réplicas d'un même bot sur une seule infra |
| Persistance | PostgreSQL |
| Coordination inter-réplicas | Redis (locks distribués) |
| Langue | Français |

## Démarrage ultra rapide

1. Copier la configuration:

```bash
cp .env.example .env
```

2. Renseigner au minimum dans `.env`:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`

3. Lancer la stack complète:

```bash
docker compose up -d --build
```

4. Vérifier:

```bash
docker compose ps
docker compose logs --tail=200 bot
```

5. Arrêt propre:

```bash
docker compose down
```

## Architecture

```mermaid
flowchart LR
    D[Discord Gateway/API] --> B[Quantum Jukebox\nN replicas]
    B --> R[(Redis\nlocks distribués)]
    B --> P[(PostgreSQL\nsettings + playlists + panels)]
    B --> L[Lavalink v4\nyoutube-plugin + lavasrc]
    L --> C[yt-cipher]
```

## Pourquoi le multi-réplicas reste stable

- Les interactions Discord sont verrouillées via Redis pour éviter le double traitement.
- Le state critique est partagé dans PostgreSQL (settings, playlists, registre panel).
- Les commandes slash restent publiées sur le serveur cible (`DISCORD_GUILD_ID`) pour un usage mono-serveur maîtrisé.

## Configuration (variables importantes)

| Variable | Requis | Défaut | Description |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Oui | - | Token du bot Discord |
| `DISCORD_CLIENT_ID` | Oui | - | ID application Discord |
| `DISCORD_GUILD_ID` | Oui | - | ID du serveur Discord cible |
| `POSTGRES_URL` | Non | `postgresql://quantum:quantum@localhost:5432/quantum_jukebox` | Connexion PostgreSQL |
| `REDIS_URL` | Non | `redis://localhost:6379` | Connexion Redis |
| `LAVALINK_HOST` | Non | `localhost` | Hôte Lavalink |
| `LAVALINK_PORT` | Non | `2333` | Port Lavalink |
| `LAVALINK_PASSWORD` | Non | `youshallnotpass` | Mot de passe Lavalink |
| `MAX_TRACKS_PER_PLAYLIST` | Non | `101` | Plafonné automatiquement à `101` |
| `DJ_ROLE_IDS` | Non | vide | IDs de rôles DJ autorisés (CSV) |

## Commandes utilisateur

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

### Comportement serveur

- `/autoplay [enabled]`
- `/mode247 [enabled]`

### Panel

- `/panel pin`
- `/panel refresh`
- `/panel unpin`

### Playlists custom

- `/playlist create name`
- `/playlist list`
- `/playlist info name`
- `/playlist add name query`
- `/playlist savecurrent name`
- `/playlist savequeue name`
- `/playlist savesession name [limit<=101]`
- `/playlist remove name index`
- `/playlist play name [shuffle]`

## Contrat fonctionnel

- Recherche texte: **YouTube prioritaire**.
- Spotify: accepté via **liens directs** (métadonnées résolues par Lavalink/LavaSrc).
- Import playlist: max `101` pistes par opération.
- Sources non supportées: erreur explicite, en français.

## Exploitation

### Monter à plusieurs réplicas

```bash
docker compose up -d --scale bot=3
```

### Logs live

```bash
docker compose logs -f bot
```

### Rebuild après mise à jour

```bash
docker compose down
docker compose up -d --build
```

## Développement local

```bash
npm install
npm run check
npm run build
npm run dev
```

## Dépannage rapide

### `DiscordAPIError[50001]: Missing Access`

Causes typiques:

- bot non présent dans le serveur cible
- mauvais `DISCORD_GUILD_ID`
- permissions/scopes OAuth2 Discord incomplets

### Erreur PostgreSQL/Redis au tout premier boot

Le bot peut démarrer avant les dépendances. Avec `restart: unless-stopped`, il repart automatiquement dès que Postgres/Redis répondent.

## Arborescence utile

```text
src/
  commands/                  commandes slash
  config/                    lecture et validation de la config env
  core/                      client Discord + orchestration
  modules/infrastructure/    PostgreSQL + Redis locks
  modules/music/             playback, panel, settings, lavalink
  modules/playlists/         playlists custom
  modules/providers/         résolution des providers (YouTube/Spotify)
```
