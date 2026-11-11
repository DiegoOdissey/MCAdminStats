'use strict';

/* ---------------------------------------------------------------- helpers */
const $ = (s) => document.querySelector(s);
const ICON_DIR = '/assets/icons/';   // primary-stat icons   (see README for file names)
// Item and mob icons come from the backend (/api/icon/...), which uses a local file in
// public/assets/items|mobs/<id>.png if present, otherwise fetches + caches it from the asset repo.
const ITEM_DIR = '/api/icon/item/';
const MOB_DIR = '/api/icon/mob/';

async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

const fmt = (n) => Math.round(n).toLocaleString();
const fmtDec = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
function hm(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h.toLocaleString()}h ${m}m`;
}
const pretty = (id) => id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function when(ms) {
  if (!ms) return 'Unknown';
  const d = new Date(ms);
  const abs = d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  let rel;
  if (mins < 1) rel = 'just now';
  else if (mins < 60) rel = `${mins}m ago`;
  else if (mins < 1440) rel = `${Math.floor(mins / 60)}h ago`;
  else rel = `${Math.floor(mins / 1440)}d ago`;
  return `${abs} (${rel})`;
}

function skin(type, uuid, name, cls, size) {
  const img = el('img', { class: cls, src: `/api/skin/${type}/${uuid}`, alt: name, loading: 'lazy' });
  img.addEventListener('error', () => {
    const f = el('div', { class: `fallback-head ${type === 'body' ? 'fallback-body' : ''}`, text: (name || '?').charAt(0).toUpperCase() });
    if (size) { f.style.width = f.style.height = size + 'px'; }
    img.replaceWith(f);
  });
  return img;
}

// Image with a placeholder if the icon file is not present yet.
function iconImg(src, cls, glyph, fallbackCls = 'ph') {
  const img = el('img', { class: cls, src, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(el('div', { class: fallbackCls, text: glyph })));
  return img;
}

// Textures that are grayscale in the game files and get colored by the biome at runtime.
function tintFor(id) {
  if (/_leaves$/.test(id)) {
    if (/^(azalea|flowering_azalea|cherry|pale_oak)_/.test(id)) return null;
    if (id.startsWith('spruce')) return '#619961';
    if (id.startsWith('birch')) return '#80a755';
    return '#48b518';
  }
  if (['grass_block', 'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern'].includes(id)) return '#79c05a';
  if (id === 'vine') return '#48b518';
  return null;
}

// Icon for the Top-50 lists: <img>, multiplied with a biome tint when needed,
// or a letter placeholder when no icon could be found.
function itemIcon(dir, id) {
  const src = dir + id;
  const ph = () => el('div', { class: 'ph small', text: id.charAt(0).toUpperCase() });
  const tint = dir === ITEM_DIR ? tintFor(id) : null;
  const img = new Image();
  img.loading = 'lazy';
  img.alt = '';
  img.addEventListener('error', () => img.replaceWith(ph()));
  if (tint) {
    img.addEventListener('load', () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        x.globalCompositeOperation = 'multiply';
        x.fillStyle = tint;
        x.fillRect(0, 0, c.width, c.height);
        x.globalCompositeOperation = 'destination-in';
        x.drawImage(img, 0, 0);
        c.className = 'tinted';
        img.replaceWith(c);
      } catch { /* leave untinted */ }
    }, { once: true });
  }
  img.src = src;
  return img;
}

/* ------------------------------------------------------------ player grid */
async function loadPlayers() {
  const grid = $('#grid');
  const notice = $('#notice');
  grid.replaceChildren();
  notice.hidden = true;
  try {
    const { players } = await api('/api/players');
    if (!players.length) {
      notice.textContent = 'No player stat files found in this world yet.';
      notice.hidden = false;
      return;
    }
    players.forEach((p, i) => {
      const card = el('button', { class: 'card', style: `animation-delay:${Math.min(i * 30, 400)}ms`, onclick: () => openPlayer(p) },
        skin('avatar', p.uuid, p.name, 'head', 64),
        el('div', {},
          el('div', { class: 'name', text: p.name }),
          el('div', { class: 'joined', text: 'Last joined: ' + when(p.lastJoined) })));
      grid.append(card);
    });
  } catch (e) {
    notice.textContent = e.message.includes('not configured') || e.message.includes('does not exist') || e.message.includes('No stats')
      ? `${e.message} Click the gear icon (bottom right) to set your server directory.`
      : e.message;
    notice.hidden = false;
  }
}

/* ----------------------------------------------------------- player modal */
const TOP_SECTIONS = [
  ['used', 'Used', ITEM_DIR],
  ['broken', 'Broken', ITEM_DIR],
  ['mined', 'Mined', ITEM_DIR],
  ['killed', 'Killed', MOB_DIR],
  ['crafted', 'Crafted', ITEM_DIR],
  ['picked_up', 'Picked up', ITEM_DIR],
];

function openOverlay(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
function closeOverlay(id) { $(id).hidden = true; document.body.style.overflow = ''; }

async function openPlayer(p) {
  const modal = $('#playerModal');
  modal.replaceChildren(el('div', { class: 'loading', text: 'Loading ' + p.name + '…' }));
  openOverlay('#playerOverlay');
  try {
    const d = await api('/api/players/' + p.uuid);
    renderPlayer(modal, d);
  } catch (e) {
    modal.replaceChildren(el('div', { class: 'loading', text: e.message }));
  }
}

function vital(label, valueNode) {
  return el('div', { class: 'vital' }, el('div', { class: 'label', text: label }), valueNode);
}
function barVital(label, cls, value, max) {
  const wrap = el('div');
  if (value == null) {
    wrap.append(el('div', { class: 'value', text: '—' }));
  } else {
    const fill = el('i');
    wrap.append(el('div', { class: 'value', text: `${fmtDec(value)} / ${max}` }), el('div', { class: `bar ${cls}` }, fill));
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = Math.max(0, Math.min(100, (value / max) * 100)) + '%'; }));
  }
  return vital(label, wrap);
}

function renderPlayer(modal, d) {
  const pl = d.player;
  const posNode = pl && pl.pos
    ? el('div', {},
        el('div', { class: 'pos' },
          ...['X', 'Y', 'Z'].map((axis, i) => el('div', {}, el('b', { text: axis }), el('span', { text: fmt(pl.pos[i]) })))),
        pl.dimension ? el('div', { class: 'dim', text: pretty(pl.dimension.replace('minecraft:', '')) }) : null)
    : el('div', { class: 'value', text: '—' });

  const vitals = el('div', { class: 'vitals' },
    barVital('Health', 'hp', pl ? pl.health : null, 20),
    barVital('Hunger', 'food', pl ? pl.food : null, 20),
    vital('XP Level', el('div', { class: 'value xp-value', text: pl ? String(pl.xpLevel) : '—' })),
    vital('Position', posNode));

  const P = d.primary;
  const primaryRows = [
    ['playtime', '⏱', 'Playtime', hm(P.playtimeSeconds)],
    ['deaths', '💀', 'Total deaths', fmt(P.deaths)],
    ['player-kills', '⚔', 'Player kills', fmt(P.playerKills)],
    ['killed-by-players', '🗡', 'Deaths by players', fmt(P.deathsByPlayers)],
    ['blocks-mined', '⛏', 'Total blocks mined', fmt(P.blocksMined)],
    ['mobs-killed', '👾', 'Total mobs killed', fmt(P.mobsKilled)],
  ].map(([file, glyph, label, val]) =>
    el('div', { class: 'row' },
      iconImg(`${ICON_DIR}${file}.png`, 'ico', glyph),
      el('div', { class: 'lbl', text: label }),
      el('div', { class: 'val', text: val })));

  const S = d.secondary;
  const secondary = el('div', { class: 'secondary' },
    ...[
      ['Total jumps', fmt(S.jumps)],
      ['Times slept', fmt(S.timesSlept)],
      ['Damage dealt', fmt(S.damageDealt)],
      ['Damage taken', fmt(S.damageTaken)],
      ['Sneak time', hm(S.sneakSeconds)],
      ['Times left world', fmt(S.timesLeftWorld)],
    ].map(([l, v]) => el('div', { class: 'tile' }, el('div', { class: 'label', text: l }), el('div', { class: 'value', text: v }))));

  const sections = TOP_SECTIONS.map(([key, title, dir]) => {
    const list = d.top[key];
    const det = el('details', { class: 'top' },
      el('summary', {}, el('span', {}, title, el('small', { text: `${list.length} entries` })), el('span', { class: 'chev', text: '›' })));
    let built = false;
    det.addEventListener('toggle', () => {
      if (!det.open || built) return;
      built = true;
      if (!list.length) { det.append(el('div', { class: 'empty', text: 'Nothing recorded.' })); return; }
      det.append(el('div', { class: 'toplist' },
        ...list.map((it) => el('div', { class: 'item' },
          el('span', { class: 'count', text: fmt(it.count) }),
          itemIcon(dir, it.id),
          el('span', { class: 'nm', title: it.id, text: pretty(it.id) })))));
    });
    return det;
  });

  const side = el('div', { class: 'side' },
    skin('body', d.uuid, d.name, 'body-render'),
    el('div', { class: 'pname', text: d.name }),
    el('div', { class: 'pjoined', text: 'Last joined: ' + when(d.lastJoined) }));

  modal.replaceChildren(
    el('button', { class: 'close', 'aria-label': 'Close', text: '✕', onclick: () => closeOverlay('#playerOverlay') }),
    el('div', { class: 'layout' },
      side,
      el('div', {}, vitals, el('div', { class: 'primary' }, ...primaryRows), secondary, ...sections)));
}

/* --------------------------------------------------------------- settings */
async function openSettings() {
  $('#settingsError').hidden = true;
  try {
    const c = await api('/api/config');
    $('#rootInput').value = c.serverRoot || '';
    $('#settingsInfo').textContent = c.world
      ? `World "${c.world.level}" detected. Stats: ${c.world.statsDir}`
      : (c.error || '');
  } catch { /* ignore */ }
  openOverlay('#settingsOverlay');
  $('#rootInput').focus();
}

async function saveSettings() {
  const err = $('#settingsError');
  err.hidden = true;
  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverRoot: $('#rootInput').value }),
    });
    closeOverlay('#settingsOverlay');
    loadPlayers();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsCancel').addEventListener('click', () => closeOverlay('#settingsOverlay'));
$('#settingsSave').addEventListener('click', saveSettings);
$('#rootInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
for (const id of ['#settingsOverlay', '#playerOverlay']) {
  $(id).addEventListener('mousedown', (e) => { if (e.target === $(id)) closeOverlay(id); });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeOverlay('#playerOverlay'); closeOverlay('#settingsOverlay'); }
});

loadPlayers();
