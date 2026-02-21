# Quantum Jukebox

Quantum Jukebox is a modular Discord music bot inspired by Star Citizen, built to reach a high-end feature set similar to Lara-style music bots:

- multi-provider playback and playlist URLs (YouTube, SoundCloud, Spotify/Apple/Deezer metadata via LavaSrc)
- advanced custom playlist system per server
- autoplay and 24/7 mode
- DJ role policy
- filter presets and queue controls
- single-server deployment (guild-only slash commands)

## Tech stack

- `discord.js` for slash commands and gateway
- `lavalink-client` for playback control
- Lavalink v4 + plugins (`youtube-plugin`, `lavasrc-plugin`)
- `yt-cipher` sidecar for YouTube cipher stability
- JSON persistence for guild settings and custom playlists

## Project layout

```text
src/
  commands/                  slash commands
  config/                    env parsing and runtime config
  core/                      client, command registry, interaction helpers
  modules/music/             lavalink + playback + filters + autoplay + 24/7
  modules/playlists/         custom playlist storage/service
  modules/policies/          DJ policy checks
  modules/providers/         provider/query resolver
```

## Commands (current)

- `/play query:<url|text>`
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
- `/playlist remove name index`
- `/playlist play name [shuffle]`

## Quick start (local)

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Fill `.env` with your Discord token, app/client id, and your target Discord server id (`DISCORD_GUILD_ID`).

4. Start Lavalink + yt-cipher:

```bash
docker compose up -d yt-cipher lavalink
```

5. Run the bot:

```bash
npm run dev
```

## Full Docker run

```bash
docker compose up -d --build
```

## Notes

- Spotify/Apple/Deezer playback depends on Lavalink plugin support and credentials; direct audio is not streamed from those services, tracks are resolved to playable sources.
- YouTube playback uses `yt-cipher` through `remoteCipher` to reduce breakages caused by frequent player-script changes.
- `YOUTUBE_FALLBACK_SOURCE` controls which search source is tried first when a YouTube track fails (`scsearch`, `ytsearch`, `ytmsearch`).
- `MUSIC_PANEL_EMOJI` accepts unicode or custom animated Discord emoji syntax (`<a:name:id>`).
- Commands are registered in `DISCORD_GUILD_ID` only (optimized for one-server deployment).
- `DJ_ROLE_IDS` accepts comma-separated role ids.
