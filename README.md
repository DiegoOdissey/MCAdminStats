# Minecraft Admin Stats

Lightweight self-hosted dashboard for Minecraft server player statistics.
Node.js + Express backend, plain HTML/CSS/JS frontend (no build step), one dependency (`express`).

## Setup

Requires Node.js 18 or newer.

```bash
cd mc-stats-dashboard
npm install
node server.js          # default port 82
```

Then open `http://<local-or-tailscale-ip>:82`, click the gear icon (bottom right) and enter your
server root folder, e.g. `/home/minecraft/server` (the folder containing `server.properties` and `usercache.json`).
The setting is saved to `config.json`.

### Port 82 on Linux
Ports below 1024 need privileges. Either:
- use another port: `PORT=8082 node server.js`, or
- allow Node to bind low ports: `sudo setcap 'cap_net_bind_service=+ep' "$(which node)"`, or
- run as root (not recommended).

### Run in the background (systemd)
`/etc/systemd/system/mc-stats.service`:
```ini
[Unit]
Description=Minecraft Admin Stats
After=network.target

[Service]
WorkingDirectory=/opt/mc-stats-dashboard
ExecStart=/usr/bin/node server.js
Environment=PORT=82
Restart=on-failure
User=minecraft
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now mc-stats`

There is no authentication, so only expose it on your LAN / Tailscale. Set `HOST=100.x.y.z` to bind to a single interface.

## How it reads your server
| Data | Source |
|---|---|
| World folder | `level-name` in `server.properties` (default `world`) |
| Names | `usercache.json`, falling back to the Mojang API (cached in `cache/names.json`) |
| Stats | `<world>/stats/<uuid>.json` |
| Health, hunger, XP, position | `<world>/playerdata/<uuid>.dat` (gzipped NBT, parsed by `lib/nbt.js`) |
| Last joined | last-modified time of the stats file (falls back to the `.dat`) |

Newer Minecraft versions reorganised the world folder; the dashboard also checks
`<world>/players/stats` and `<world>/players/data`, so it should work with both layouts.
Note: the stats file is rewritten whenever the server saves, so "last joined" is really "last saved".

Skins are fetched by the backend (Crafatar, then mc-heads.net, then Minotar as fallbacks) and cached
in `cache/skins` for 6 hours. If the host has no internet, a coloured initial is shown instead.
Cracked/offline-mode servers use offline UUIDs which have no skins, so those players get the fallback too.

## Icons (placeholders)
Drop PNG files in these folders. Anything missing shows a placeholder tile automatically.

| Folder | File names |
|---|---|
| `public/assets/icons/` | `playtime.png`, `deaths.png`, `player-kills.png`, `killed-by-players.png`, `blocks-mined.png`, `mobs-killed.png` |
| `public/assets/items/` | item/block id + `.png`, e.g. `diamond_pickaxe.png`, `spruce_planks.png` (used by Used / Broken / Mined / Crafted / Picked up) |
| `public/assets/mobs/` | mob id + `.png`, e.g. `zombie.png`, `skeleton.png` (used by Killed) |

Item icons can come from any Minecraft asset/icon pack that names files by the item id.

## Notes
- "Damage dealt/taken" are shown in HP (the raw stat is stored in tenths of a heart-point).
- Playtime reads `play_time` (1.21.2+) and falls back to the older `play_one_minute`.
- Stats files are read fresh on each request, so no restart is needed after the server saves.
