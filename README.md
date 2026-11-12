# Minecraft Admin Statistics

This project is a lightweight self-hosted dashboard for Minecraft server owners that want a quick and easy way to see their players statistics inside the server. 
The project runs on Node.js with Express as backend, plain HTML, CSS and JS for the frontend, and one dependency, `express`.

## Setup
The project requires Node.js 18 or newer.
```bash
cd mc-stats-dashboard
npm install
node server.js          # default port is 8080
```

To visit the website, open `https://<your-server-ip>:82` and click the gear icon on the bottom right to set the server's root directory, for example `/home/minecraft/server`. 

**Important**: set the server's **root** directory, where the world folder is, not the world folder itself. 

The configuration will be automatically saved into `config.json`.

The website will automatically detect the current world set in `server.properties`, so there's no need to modify anything in a multi-world setup.

### Running in the background (Linux)
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

There is **no authentication**, so only expose it on your LAN / Tailscale. Set `HOST=100.x.y.z` to bind to a single interface.

## How the data is obtained
| Data | Source |
|---|---|
| World folder | `level-name` in `server.properties` (default `world`) |
| Names | `usercache.json`, falling back to the Mojang API (cached in `cache/names.json`) |
| Stats | `<world>/stats/<uuid>.json` |
| Health, hunger, XP, position | `<world>/playerdata/<uuid>.dat` (gzipped NBT, parsed by `lib/nbt.js`) |
| Last joined | last-modified time of the stats file (falls back to the `.dat`) |

Newer Minecraft versions reorganized the world folder structure, so the dashboard also checks for `<world>/player/stats` and `<world>/player/data`, so it should work regardless.

*Note: the "Last joined" date is obtained from the player's JSON file's last saved date*

**Skins** are fetched by the backend *(Craftar, mc-heads.net, Minotar) and cached in `cache/skins/` for 6 hours. If the host has no internet, a coloured initial is shown instead.
Cracked/offline-mode servers use offline UUIDs which have no skins, so those player get the initial too.

### Icons
Item and block icons now load automatically inside the collapsible menus, which are pulled from the open minecraft-assets repo on GitHub. Those are cached inside `cache/icons/`, similar to skins. Icons that couldn't be succesfully loaded will fallback to a coloured initial. 

### License
MIT