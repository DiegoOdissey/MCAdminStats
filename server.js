'use strict';
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { parseNBT } = require('./lib/nbt');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const NAME_CACHE_PATH = path.join(__dirname, 'cache', 'names.json');
const SKIN_CACHE_DIR = path.join(__dirname, 'cache', 'skins');
fs.mkdirSync(SKIN_CACHE_DIR, { recursive: true });

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const STATS_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

/* ------------------------------------------------------------------ config */
function loadConfig() {
  const defaults = { serverRoot: '', port: 82 };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return defaults;
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let config = loadConfig();

/* ------------------------------------------------------------ world layout */
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Finds the stats + playerdata folders for the configured server root.
 * Supports the classic layout   (world/stats, world/playerdata)
 * and the newer layout          (world/players/stats, world/players/data)
 * and lets the user point straight at the world folder itself.
 */
function resolveWorld(root) {
  if (!root || !isDir(root)) return { ok: false, error: 'Server directory does not exist.' };

  let level = 'world';
  try {
    const props = fs.readFileSync(path.join(root, 'server.properties'), 'utf8');
    const m = props.match(/^level-name=(.*)$/m);
    if (m && m[1].trim()) level = m[1].trim();
  } catch { /* no server.properties, keep default */ }

  const candidates = [path.join(root, level), root];
  for (const worldDir of candidates) {
    const statsDir = [path.join(worldDir, 'stats'), path.join(worldDir, 'players', 'stats')].find(isDir);
    if (!statsDir) continue;
    const dataDir = [path.join(worldDir, 'playerdata'), path.join(worldDir, 'players', 'data')].find(isDir) || null;
    return { ok: true, root, level, worldDir, statsDir, dataDir };
  }
  return { ok: false, error: `No stats folder found (looked in "${level}/stats" and "${level}/players/stats").` };
}

/* ----------------------------------------------------------- username map */
let nameCache = {};
try { nameCache = JSON.parse(fs.readFileSync(NAME_CACHE_PATH, 'utf8')); } catch { /* first run */ }
function persistNameCache() {
  try {
    fs.mkdirSync(path.dirname(NAME_CACHE_PATH), { recursive: true });
    fs.writeFileSync(NAME_CACHE_PATH, JSON.stringify(nameCache, null, 2));
  } catch { /* non fatal */ }
}

function readUsercache(root) {
  const map = {};
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(root, 'usercache.json'), 'utf8'));
    for (const e of arr) if (e && e.uuid && e.name) map[e.uuid.toLowerCase()] = e.name;
  } catch { /* missing or unreadable */ }
  return map;
}

async function mojangName(uuid) {
  try {
    const r = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`,
      { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.name ? j.name : null;
  } catch { return null; }
}

async function resolveNames(root, uuids) {
  const local = readUsercache(root);
  const out = {};
  const missing = [];
  for (const u of uuids) {
    const key = u.toLowerCase();
    if (local[key]) { out[u] = local[key]; nameCache[key] = local[key]; }
    else if (nameCache[key]) out[u] = nameCache[key];
    else missing.push(u);
  }
  if (missing.length) {
    await Promise.all(missing.map(async (u) => {
      const n = await mojangName(u);
      if (n) { nameCache[u.toLowerCase()] = n; out[u] = n; }
      else out[u] = u.slice(0, 8); // last resort: short UUID
    }));
  }
  persistNameCache();
  return out;
}

/* ------------------------------------------------------------- stats logic */
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);

function topN(obj, n = 50) {
  return Object.entries(obj || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ id: k.replace(/^minecraft:/, ''), count: v }));
}

function readPlayerData(world, uuid) {
  if (!world.dataDir) return null;
  const file = path.join(world.dataDir, `${uuid}.dat`);
  try {
    const nbt = parseNBT(fs.readFileSync(file));
    const pos = Array.isArray(nbt.Pos) ? nbt.Pos : null;
    return {
      health: nbt.Health ?? null,
      food: nbt.foodLevel ?? nbt.food_level ?? null,
      saturation: nbt.foodSaturationLevel ?? null,
      xpLevel: nbt.XpLevel ?? 0,
      pos: pos ? pos.map((v) => Math.floor(v)) : null,
      dimension: typeof nbt.Dimension === 'string' ? nbt.Dimension : null,
    };
  } catch {
    return null;
  }
}

function lastModified(world, uuid) {
  const candidates = [path.join(world.statsDir, `${uuid}.json`)];
  if (world.dataDir) candidates.push(path.join(world.dataDir, `${uuid}.dat`));
  for (const f of candidates) {
    try { return fs.statSync(f).mtimeMs; } catch { /* try next */ }
  }
  return null;
}

function buildDetail(world, uuid, name) {
  const raw = JSON.parse(fs.readFileSync(path.join(world.statsDir, `${uuid}.json`), 'utf8'));
  const s = raw.stats || {};
  const c = s['minecraft:custom'] || {};
  const killedBy = s['minecraft:killed_by'] || {};
  const killed = s['minecraft:killed'] || {};

  const playTicks = c['minecraft:play_time'] ?? c['minecraft:play_one_minute'] ?? 0;
  const mobKills = c['minecraft:mob_kills'] ?? sum(killed);

  return {
    uuid,
    name,
    lastJoined: lastModified(world, uuid),
    player: readPlayerData(world, uuid),
    primary: {
      playtimeSeconds: Math.floor(playTicks / 20),
      deaths: c['minecraft:deaths'] ?? 0,
      playerKills: c['minecraft:player_kills'] ?? 0,
      deathsByPlayers: killedBy['minecraft:player'] ?? 0,
      blocksMined: sum(s['minecraft:mined']),
      mobsKilled: mobKills,
    },
    secondary: {
      jumps: c['minecraft:jump'] ?? 0,
      timesSlept: c['minecraft:sleep_in_bed'] ?? 0,
      damageDealt: (c['minecraft:damage_dealt'] ?? 0) / 10, // stored in 1/10 HP
      damageTaken: (c['minecraft:damage_taken'] ?? 0) / 10,
      sneakSeconds: Math.floor((c['minecraft:sneak_time'] ?? 0) / 20),
      timesLeftWorld: c['minecraft:leave_game'] ?? 0,
    },
    top: {
      used: topN(s['minecraft:used']),
      broken: topN(s['minecraft:broken']),
      mined: topN(s['minecraft:mined']),
      killed: topN(s['minecraft:killed']),
      crafted: topN(s['minecraft:crafted']),
      picked_up: topN(s['minecraft:picked_up']),
    },
  };
}

/* --------------------------------------------------------------------- app */
const app = express();
app.use(express.json());

// Skin cache lives in ./cache so images are served locally after the first fetch.
const SKIN_SOURCES = {
  avatar: [
    (u) => `https://crafatar.com/avatars/${u}?size=96&overlay`,
    (u) => `https://mc-heads.net/avatar/${u}/96`,
    (u) => `https://minotar.net/helm/${u}/96.png`,
  ],
  body: [
    (u) => `https://crafatar.com/renders/body/${u}?scale=6&overlay`,
    (u) => `https://mc-heads.net/body/${u}/220`,
    (u) => `https://minotar.net/armor/body/${u}/220.png`,
  ],
};
const SKIN_TTL = 6 * 3600 * 1000;
const NEG_TTL = 10 * 60 * 1000;
const negative = new Map();

app.get('/api/skin/:type/:uuid', async (req, res) => {
  const { type, uuid } = req.params;
  if (!SKIN_SOURCES[type] || !UUID_RE.test(uuid)) return res.status(400).end();
  const id = uuid.toLowerCase();
  const file = path.join(SKIN_CACHE_DIR, `${type}_${id}.png`);

  let stat = null;
  try { stat = await fsp.stat(file); } catch { /* not cached */ }
  const fresh = stat && Date.now() - stat.mtimeMs < SKIN_TTL;
  const key = `${type}:${id}`;

  if (!fresh && !(negative.get(key) > Date.now())) {
    for (const mk of SKIN_SOURCES[type]) {
      try {
        const r = await fetch(mk(id), { signal: AbortSignal.timeout(5000) });
        if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) continue;
        await fsp.writeFile(file, Buffer.from(await r.arrayBuffer()));
        stat = await fsp.stat(file);
        negative.delete(key);
        break;
      } catch { /* try next provider */ }
    }
    if (!stat) negative.set(key, Date.now() + NEG_TTL);
  }

  if (!stat) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('png').sendFile(file);
});

/* ------------------------------------------------------------------ icons */
// Item/mob icons are resolved from the open minecraft-assets repo on GitHub
// (textures + models), cached forever in ./cache/icons, and served from here.
// A local file in public/assets/items|mobs/<id>.png always wins if present.
const ICON_REF = process.env.ICON_REF || config.iconVersion || '1.21.11';
const ICON_RAW = `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${ICON_REF}/assets/minecraft/`;
const ICON_CACHE_DIR = path.join(__dirname, 'cache', 'icons');
fs.mkdirSync(ICON_CACHE_DIR, { recursive: true });

const ID_RE = /^[a-z0-9_]+$/;
const jsonCache = new Map();
const inflight = new Map();
const iconMiss = new Map(); // id -> retry-after timestamp (negative cache)

async function fetchRaw(rel) {
  try {
    const r = await fetch(ICON_RAW + rel, { signal: AbortSignal.timeout(8000) });
    return r.ok ? r : null;
  } catch { return null; }
}
async function getJSON(rel) {
  if (jsonCache.has(rel)) return jsonCache.get(rel);
  const r = await fetchRaw(rel);
  let j = null;
  if (r) { try { j = await r.json(); } catch { j = null; } }
  jsonCache.set(rel, j);
  return j;
}
const stripNs = (s) => String(s).replace(/^minecraft:/, '');

// Finds the first "model": "<id>" string inside an items/<id>.json definition.
function findModelRef(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.model === 'string') return node.model;
  for (const v of Object.values(node)) {
    const found = findModelRef(v);
    if (found) return found;
  }
  return null;
}

// Walks a model's parent chain and merges its texture map (child overrides parent).
async function modelTextures(modelPath, depth = 0) {
  if (depth > 6) return {};
  const m = await getJSON(`models/${stripNs(modelPath)}.json`);
  if (!m) return {};
  const parent = m.parent && !/^(minecraft:)?builtin\//.test(m.parent) ? await modelTextures(m.parent, depth + 1) : {};
  return { ...parent, ...(m.textures || {}) };
}

const TEX_PRIORITY = ['layer0', 'all', 'texture', 'side', 'front', 'north', 'top', 'up', 'end', 'cross', 'torch', 'plant', 'pattern'];
const PREFER_KEY = { grass_block: 'top', podzol: 'top', mycelium: 'top', crafting_table: 'front', furnace: 'front', smoker: 'front', barrel: 'side' };

function pickTexture(id, tex) {
  const resolve = (v, n = 0) => (typeof v === 'string' && v.startsWith('#') && n < 6 ? resolve(tex[v.slice(1)], n + 1) : v);
  const keys = [PREFER_KEY[id], ...TEX_PRIORITY, ...Object.keys(tex).filter((k) => k !== 'particle'), 'particle'].filter(Boolean);
  for (const k of keys) {
    const v = resolve(tex[k]);
    if (typeof v === 'string' && !v.startsWith('#')) return stripNs(v);
  }
  return null;
}

async function remoteTexture(rel) {
  const r = await fetchRaw(`textures/${rel}.png`);
  return r ? Buffer.from(await r.arrayBuffer()) : null;
}

// Stat ids that are blocks/entities without an item of their own -> nearest item.
const ICON_ALIAS = {
  sweet_berry_bush: 'sweet_berries', wall_torch: 'torch', soul_wall_torch: 'soul_torch', cave_vines: 'glow_berries',
  cave_vines_plant: 'glow_berries', kelp_plant: 'kelp', redstone_wall_torch: 'redstone_torch', tripwire: 'string',
  redstone_wire: 'redstone', water_cauldron: 'cauldron', lava_cauldron: 'cauldron', potatoes: 'potato', carrots: 'carrot',
  beetroots: 'beetroot', fire: 'flint_and_steel', soul_fire: 'flint_and_steel',
};

async function resolveIcon(kind, id) {
  if (kind === 'mob') return remoteTexture(`item/${id}_spawn_egg`);
  id = ICON_ALIAS[id] || id;

  const modelIds = [];
  const def = await getJSON(`items/${id}.json`);
  const ref = findModelRef(def);
  if (ref) modelIds.push(ref);
  modelIds.push(`item/${id}`, `block/${id}`, `block/${id}_inventory`);

  for (const mid of [...new Set(modelIds)]) {
    const tex = pickTexture(id, await modelTextures(mid));
    if (!tex) continue;
    const png = await remoteTexture(tex);
    if (png) return png;
  }
  return remoteTexture(`item/${id}`) || null;
}

app.get('/api/icon/:kind/:id', async (req, res) => {
  const { kind, id } = req.params;
  if ((kind !== 'item' && kind !== 'mob') || !ID_RE.test(id)) return res.status(400).end();

  // 1) user-supplied local override
  const local = path.join(__dirname, 'public', 'assets', kind === 'mob' ? 'mobs' : 'items', `${id}.png`);
  if (fs.existsSync(local)) return res.set('Cache-Control', 'public, max-age=3600').type('png').sendFile(local);

  // 2) disk cache
  const file = path.join(ICON_CACHE_DIR, `${kind}_${id}.png`);
  if (fs.existsSync(file)) return res.set('Cache-Control', 'public, max-age=86400').type('png').sendFile(file);

  // 3) resolve from the asset repo (deduplicated, with short negative cache)
  const key = `${kind}:${id}`;
  if ((iconMiss.get(key) || 0) > Date.now()) return res.status(404).end();
  if (!inflight.has(key)) {
    inflight.set(key, resolveIcon(kind, id).catch(() => null).finally(() => inflight.delete(key)));
  }
  const png = await inflight.get(key);
  if (!png) {
    iconMiss.set(key, Date.now() + 30 * 60 * 1000);
    return res.status(404).end();
  }
  try { await fsp.writeFile(file, png); } catch { /* cache dir not writable: still serve it */ }
  res.set('Cache-Control', 'public, max-age=86400').type('png').send(png);
});

app.get('/api/config', (req, res) => {
  const world = resolveWorld(config.serverRoot);
  res.json({
    serverRoot: config.serverRoot,
    configured: !!config.serverRoot,
    ok: world.ok,
    error: world.ok ? null : (config.serverRoot ? world.error : null),
    world: world.ok ? { level: world.level, statsDir: world.statsDir, dataDir: world.dataDir } : null,
  });
});

app.post('/api/config', (req, res) => {
  const root = String((req.body && req.body.serverRoot) || '').trim();
  if (!root) return res.status(400).json({ error: 'Please enter a path.' });
  const resolved = path.resolve(root);
  const world = resolveWorld(resolved);
  if (!world.ok) return res.status(400).json({ error: world.error });
  config.serverRoot = resolved;
  try { saveConfig(config); }
  catch (e) { return res.status(500).json({ error: 'Cannot write config.json: ' + e.message }); }
  res.json({ ok: true, serverRoot: resolved, world: { level: world.level, statsDir: world.statsDir, dataDir: world.dataDir } });
});

app.get('/api/players', async (req, res) => {
  const world = resolveWorld(config.serverRoot);
  if (!world.ok) return res.status(409).json({ error: world.error || 'Server directory not configured.' });

  const uuids = fs.readdirSync(world.statsDir)
    .filter((f) => STATS_FILE_RE.test(f))
    .map((f) => f.slice(0, -5));
  const names = await resolveNames(world.root, uuids);

  const players = uuids.map((uuid) => ({ uuid, name: names[uuid], lastJoined: lastModified(world, uuid) }))
    .sort((a, b) => (b.lastJoined || 0) - (a.lastJoined || 0));
  res.json({ players });
});

app.get('/api/players/:uuid', async (req, res) => {
  const { uuid } = req.params;
  if (!STATS_FILE_RE.test(uuid + '.json')) return res.status(400).json({ error: 'Invalid UUID.' });
  const world = resolveWorld(config.serverRoot);
  if (!world.ok) return res.status(409).json({ error: world.error });
  try {
    const names = await resolveNames(world.root, [uuid]);
    res.json(buildDetail(world, uuid, names[uuid]));
  } catch (e) {
    res.status(404).json({ error: 'Could not read stats for this player.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT) || config.port || 82;
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`Minecraft Admin Stats running on http://${HOST}:${PORT}`);
  console.log(config.serverRoot
    ? `Server directory: ${config.serverRoot}`
    : 'No server directory set yet - open the page and click the gear icon.');
});
server.on('error', (err) => {
  if (err.code === 'EACCES') {
    console.error(`\nCannot bind to port ${PORT} (ports below 1024 need root).`);
    console.error(`Run with a higher port:  PORT=8082 node server.js`);
    console.error(`or allow Node to bind low ports:  sudo setcap 'cap_net_bind_service=+ep' "$(which node)"\n`);
  } else if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Try:  PORT=8083 node server.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
