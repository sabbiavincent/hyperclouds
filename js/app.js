import { sunPosition, eventWindow, zonedDayStart, formatLocal, SUN_SEMIDIAMETER } from './solar.js';
import { destination, rayAltitude, horizonDistanceToLayer, DEFAULT_K } from './geodesy.js';
import { Dem, browserTileLoader } from './dem.js';
import { parseCoords } from './coords.js';
import { prefetchFan, horizonProfile, horizonAt, transect, rayTerrainHit, BANDS, MAX_DIST } from './terrain.js';
import { fetchMeta, fetchTransectClouds, cloudsAtAz, rayLayerCrossings, rayClear, coverAt, callCount,
  DAILY_LIMIT, GAP_L_KM, LAYER_TOP, LAYERS, MODELS } from './weather.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('hc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hc.' + k, JSON.stringify(v)); } catch {} },
};

const dem = new Dem(browserTileLoader);
const S = {
  obs: store.get('obs', { lat: 43.7629, lon: 11.2650 }),
  type: store.get('type', 'sunset'),
  model: store.get('model', 'best_match'),
  hag: store.get('hag', 2),
  date: null, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  h0: null, win: null, profile: null, azRef: 0, weather: null, weatherErr: null,
  minutes: [], vis: [], probs: [], tIdx: 0, trCache: new Map(), loadId: 0,
  phone: null, userMoved: false, cloudCache: null,
};

// ---------- utilità ----------
const unwrap = (a, ref) => ref + ((((a - ref) % 360) + 540) % 360) - 180;
const fmtDeg = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d) + '°';
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const status = (s) => { $('status').textContent = s; };
function showCalls() {
  const n = callCount(), el = $('calls');
  el.textContent = `Chiamate Open-Meteo oggi da questo dispositivo (stima): ${n} su ${DAILY_LIMIT} (limite per rete, non per dispositivo).`;
  el.classList.toggle('warn', n > 0.8 * DAILY_LIMIT);
  if (n > 0.8 * DAILY_LIMIT) status(`Attenzione: circa ${n} chiamate Open-Meteo oggi, vicino al limite di ${DAILY_LIMIT}.`);
}

const progress = (f) => { $('bar').style.width = `${Math.round(f * 100)}%`; if (f >= 1) setTimeout(() => ($('bar').style.width = '0'), 400); };

function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  }
  const ctx = c.getContext('2d', c.id === 'timeline' ? { willReadFrequently: true } : undefined);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

// ---------- controlli ----------
MODELS.forEach((m) => $('model').add(new Option(m.label, m.id, false, m.id === S.model)));
$('hag').value = S.hag;
document.querySelectorAll('#event button').forEach((b) => {
  b.classList.toggle('on', b.dataset.v === S.type);
  b.onclick = () => {
    S.type = b.dataset.v; store.set('type', S.type);
    document.querySelectorAll('#event button').forEach((x) => x.classList.toggle('on', x === b));
    load();
  };
});
$('model').onchange = () => { S.model = $('model').value; store.set('model', S.model); loadWeather(S.loadId); };
$('date').onchange = () => { S.date = $('date').value; load({ keepMeta: true }); };
$('hag').onchange = () => { S.hag = Math.max(0, +$('hag').value || 0); store.set('hag', S.hag); load({ keepMeta: true }); };
$('reload').onclick = () => load({ keepMeta: true });
let rafPending = false;   // al massimo un ridisegno per fotogramma mentre si trascina lo slider
$('slider').oninput = () => {
  S.tIdx = +$('slider').value;
  if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderDynamic(); }); }
};
function locatePhone(auto) {
  if (!navigator.geolocation) { if (!auto) status('Geolocalizzazione non disponibile in questo browser.'); return; }
  if (!auto) status('Richiesta posizione GPS…');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      S.phone = { lat: p.coords.latitude, lon: p.coords.longitude };
      setObserver(S.phone);
    },
    (e) => { if (!auto) status(`GPS non disponibile: ${e.message}`); },
    { enableHighAccuracy: true, timeout: auto ? 8000 : 15000, maximumAge: 60000 });
}
$('gps').onclick = () => locatePhone(false);
$('coordForm').onsubmit = (e) => {
  e.preventDefault();
  const c = parseCoords($('coordIn').value);
  if (!c || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180) return status('Coordinate non riconosciute: usa "43.7696, 11.2558" oppure "43°46\'10"N 11°15\'21"E".');
  $('coordIn').blur();
  setObserver(c);
};
$('detClouds').addEventListener('toggle', () => renderDynamic());
window.addEventListener('resize', () => { renderStatic(); renderDynamic(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderStatic(); renderDynamic(); } });

// ---------- mappa ----------
const MAP_STYLES = { chiara: 'https://tiles.openfreemap.org/styles/liberty', scura: 'https://tiles.openfreemap.org/styles/dark' };
S.mapStyle = store.get('mapStyle', 'chiara');
const map = new maplibregl.Map({
  container: 'map', style: MAP_STYLES[S.mapStyle],
  center: [S.obs.lon, S.obs.lat], zoom: 7.4, attributionControl: false,
});
// Attribuzione dovuta (OpenStreetMap/OpenFreeMap) ridotta a icona: si espande al tocco.
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.once('idle', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
let mapReady = false;
// i livelli si aggiungono a ogni caricamento di stile (anche dopo il cambio chiaro/scuro)
map.on('style.load', () => {
  const empty = { type: 'FeatureCollection', features: [] };
  for (const id of ['fan', 'rings', 'rayOn', 'rayOff', 'pts']) map.addSource(id, { type: 'geojson', data: empty });
  map.addLayer({ id: 'fan', type: 'fill', source: 'fan', paint: { 'fill-color': '#f08c00', 'fill-opacity': S.mapStyle === 'chiara' ? 0.16 : 0.12 } });
  map.addLayer({ id: 'fanEdge', type: 'line', source: 'fan', paint: { 'line-color': '#f08c00', 'line-width': 1, 'line-opacity': 0.6 } });
  map.addLayer({ id: 'rings', type: 'line', source: 'rings',
    paint: { 'line-color': ['get', 'c'], 'line-width': 1, 'line-dasharray': [3, 3], 'line-opacity': 0.7 } });
  map.addLayer({ id: 'rayOff', type: 'line', source: 'rayOff',
    paint: { 'line-color': '#6b7787', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'rayOn', type: 'line', source: 'rayOn',
    layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 3.2 } });
  map.addLayer({ id: 'pts', type: 'circle', source: 'pts',
    paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  mapReady = true;
  renderMapStatic(); renderMapDynamic(currentFrame());
});
$('mapStyle').textContent = S.mapStyle === 'chiara' ? '☾' : '☀';
$('mapStyle').onclick = () => {
  S.mapStyle = S.mapStyle === 'chiara' ? 'scura' : 'chiara'; store.set('mapStyle', S.mapStyle);
  $('mapStyle').textContent = S.mapStyle === 'chiara' ? '☾' : '☀';
  mapReady = false; map.setStyle(MAP_STYLES[S.mapStyle], { diff: false });
};
map.on('click', (e) => setObserver({ lat: e.lngLat.lat, lon: e.lngLat.lng }));

function setObserver(o, { byUser = true } = {}) {
  if (byUser) S.userMoved = true;
  S.obs = o; store.set('obs', o);
  map.flyTo({ center: [o.lon, o.lat], zoom: Math.max(map.getZoom(), 7.4), duration: 600 });
  load();
}

const line = (pts) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) } });
const fc = (features) => ({ type: 'FeatureCollection', features });

function renderMapStatic() {
  if (!mapReady || !S.win?.ok || !S.profile) return;
  const o = S.obs;
  const a0 = S.azWin[0], a1 = S.azWin[1];
  const ring = [o];
  for (let i = 0; i <= 24; i++) ring.push(destination(o.lat, o.lon, MAX_DIST, a0 + ((a1 - a0) * i) / 24));
  ring.push(o);
  map.getSource('fan').setData(fc([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring.map((p) => [p.lon, p.lat])] } }]));
  // anelli: dove ciascuno strato incontra l'orizzonte (raggio orizzontale)
  const cols = { low: '#3d8bfd', mid: '#9b5de5', high: '#e5484d' };
  const rings = [3000, 8000].map((h, i) => {
    const r = horizonDistanceToLayer(S.h0, h);
    const pts = [];
    for (let az = 0; az <= 360; az += 4) pts.push(destination(o.lat, o.lon, r, az));
    return { ...line(pts), properties: { c: Object.values(cols)[i + 1] } };
  });
  map.getSource('rings').setData(fc(rings));
}

function renderMapDynamic(frame) {
  if (!mapReady) return;
  const o = S.obs;
  const pts = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [o.lon, o.lat] }, properties: { r: 6, c: '#f0643c' } }];
  if (S.phone && (Math.abs(S.phone.lat - o.lat) > 1e-4 || Math.abs(S.phone.lon - o.lon) > 1e-4)) {
    pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [S.phone.lon, S.phone.lat] }, properties: { r: 5, c: '#4ea1ff' } });
  }
  if (!frame) {
    map.getSource('pts').setData(fc(pts));
    map.getSource('rayOn').setData(fc([])); map.getSource('rayOff').setData(fc([]));
    return;
  }
  const stop = frame.hit ? frame.hit.d : MAX_DIST;
  // tratti del raggio colorati secondo lo strato attraversato (basse / medie / alte / sopra le nubi)
  const LCOL = { low: '#3d8bfd', mid: '#9b5de5', high: '#e5484d', above: '#f5a524' };
  const layerAt = (d) => { const z = rayAltitude(d, S.h0, frame.el); return z < 3000 ? 'low' : z < 8000 ? 'mid' : z < LAYER_TOP ? 'high' : 'above'; };
  const on = [], off = [];
  let seg = null;
  for (let d = 0; d <= Math.min(stop, MAX_DIST); d += 2500) {
    const p = destination(o.lat, o.lon, d, frame.az), L = layerAt(d);
    if (!seg || seg.L !== L) { if (seg) seg.pts.push(p); seg = { L, pts: [p] }; on.push(seg); } else seg.pts.push(p);
  }
  for (let d = Math.max(0, stop - 5000); d <= MAX_DIST && frame.hit; d += 5000) off.push(destination(o.lat, o.lon, d, frame.az));
  S.raySegs = on.map((g) => g.L);
  if (frame.hit) {
    seg?.pts.push({ lat: frame.hit.lat, lon: frame.hit.lon });
    pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [frame.hit.lon, frame.hit.lat] }, properties: { r: 5, c: '#f2777a' } });
  } else if (frame.tr.peak) {
    pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [frame.tr.peak.lon, frame.tr.peak.lat] }, properties: { r: 4, c: '#8b98a8' } });
  }
  map.getSource('rayOn').setData(fc(on.filter((g) => g.pts.length > 1).map((g) => ({ ...line(g.pts), properties: { c: LCOL[g.L] } }))));
  map.getSource('rayOff').setData(fc(frame.hit && off.length > 1 ? [line(off)] : []));
  map.getSource('pts').setData(fc(pts));
}

// ---------- caricamento ----------
async function load({ keepMeta = false } = {}) {
  const id = ++S.loadId;
  S.trCache.clear(); S.weather = null; S.weatherErr = null; S.profile = null; S.probs = []; S.cloudCache = null;
  $('coords').textContent = `${S.obs.lat.toFixed(4)}, ${S.obs.lon.toFixed(4)}`;
  progress(0.05);
  try {
    if (!keepMeta || !S.metaFor || S.metaFor !== `${S.obs.lat},${S.obs.lon}`) {
      status('Fuso orario del luogo…');
      try {
        const m = await fetchMeta(S.obs.lat, S.obs.lon);
        if (id !== S.loadId) return;
        S.tz = m.tz; S.metaFor = `${S.obs.lat},${S.obs.lon}`;
      } catch (e) { status(`Open-Meteo non raggiungibile (${e.message}): uso il fuso del telefono.`); }
    }
    if (!S.date) { S.date = todayIn(S.tz); $('date').value = S.date; }

    const day0 = zonedDayStart(S.date, S.tz);
    S.win = eventWindow(day0, S.obs.lat, S.obs.lon, S.type);
    if (!S.win.ok) { status(S.win.reason); renderAllEmpty(); progress(1); return; }

    status('Quota del punto…');
    const g = await dem.elevation(S.obs.lat, S.obs.lon, 13);
    if (id !== S.loadId) return;
    if (g == null) {
      // tile fallita: non resta in cache come vuota, così un nuovo tentativo la riscarica
      for (const [k, v] of dem.tiles) if (v === null) dem.tiles.delete(k);
      throw new Error(`modello del terreno non raggiungibile: ${dem.lastError || 'motivo sconosciuto'}`);
    }
    S.h0 = g + S.hag;

    // azimut della finestra (gestione del passaggio per 0/360)
    S.azRef = sunPosition(S.win.event, S.obs.lat, S.obs.lon).az;
    S.minutes = [];
    for (let t = S.win.start; t <= S.win.end; t += 60000) {
      const p = sunPosition(t, S.obs.lat, S.obs.lon);
      S.minutes.push({ t, az: unwrap(p.az, S.azRef), el: p.el });
    }
    const azs = S.minutes.map((m) => m.az);
    S.azWin = [Math.min(...azs), Math.max(...azs)];
    let a0 = S.azWin[0] - 8, a1 = S.azWin[1] + 8;
    if (a1 - a0 < 28) { const c = (a0 + a1) / 2; a0 = c - 14; a1 = c + 14; }
    a0 = Math.floor(a0 * 2) / 2; a1 = Math.ceil(a1 * 2) / 2;

    status('Terreno: scarico il modello digitale…');
    await prefetchFan(dem, S.obs, a0, a1, 0.5, (d, n) => { if (id === S.loadId) progress(0.1 + 0.7 * d / n); });
    if (id !== S.loadId) return;
    status('Calcolo dell\'orizzonte reale…');
    await new Promise((r) => setTimeout(r, 0));
    S.profile = horizonProfile(dem, S.obs, S.h0, a0, a1, 0.5);
    S.vis = S.minutes.map((m) => {
      const hz = horizonAt(S.profile, m.az);
      return m.el + SUN_SEMIDIAMETER > hz ? 'on' : m.el + SUN_SEMIDIAMETER > 0 ? 'terrain' : 'below';
    });

    // slider: parte dall'evento
    $('slider').max = S.minutes.length - 1;
    S.tIdx = Math.max(0, S.minutes.findIndex((m) => m.t >= S.win.event));
    $('slider').value = S.tIdx;
    progress(0.85);
    renderStatic(); renderDynamic(); renderMapStatic();
    const miss = S.profile.missing ? ` · ${S.profile.missing} campioni senza dati del terreno` : '';
    status(`Fuso ${S.tz}${S.win.notes.length ? ' · ' + S.win.notes.join('; ') : ''}${miss}`);
    loadWeather(id);
  } catch (e) {
    if (id === S.loadId) { status(`Errore: ${e.message}`); progress(1); }
  }
}

async function loadWeather(id) {
  if (!S.win?.ok) return;
  S.weather = null; S.weatherErr = 'caricamento…'; renderDynamic();
  try {
    // direzioni su tutto il ventaglio del panorama, al più 12° l'una dall'altra
    const a0 = S.profile.azMin, a1 = S.profile.azMax;
    const nDir = Math.max(2, Math.ceil((a1 - a0) / 12) + 1);
    const dirs = Array.from({ length: nDir }, (_, i) => a0 + ((a1 - a0) * i) / (nDir - 1));
    const res = await Promise.all(dirs.map((az) => fetchTransectClouds(S.obs, az, S.date, S.model)));
    if (id !== S.loadId) return;
    S.weather = {
      model: res[0].model,
      source: [...new Set(res.map((r) => r.source))].join(' / '),
      set: res.map((r, i) => ({ az: dirs[i], data: r })).sort((x, y) => x.az - y.az),
    };
    S.weatherErr = null;
    computeProbs();
  } catch (e) {
    if (id !== S.loadId) return;
    S.weatherErr = e.message;
  }
  progress(1);
  showCalls();
  drawTimeline();
  renderDynamic();
}

// probabilità di disco visibile per ogni minuto in cui il terreno non lo copre
function computeProbs() {
  S.probs = S.minutes.map((m, i) => {
    if (S.vis[i] !== 'on') return null;
    return rayClear(cloudsAtAz(S.weather.set, m.az, m.t), S.h0, Math.max(m.el, 0)).P;
  });
}
const probClass = (P) => (P == null ? null : P >= 0.7 ? 'libero' : P >= 0.3 ? 'incerto' : 'bloccato');

// ---------- frame corrente ----------
function currentFrame() {
  if (!S.profile || !S.minutes.length) return null;
  const m = S.minutes[Math.min(S.tIdx, S.minutes.length - 1)];
  const key = Math.round(m.az * 10) / 10;
  let tr = S.trCache.get(key);
  if (!tr) { tr = transect(dem, S.obs, S.h0, key); S.trCache.set(key, tr); }
  const hit = m.el + SUN_SEMIDIAMETER > -2 ? rayTerrainHit(tr, m.el) : null;
  const hz = horizonAt(S.profile, m.az);
  let snap = null, cross = [], clear = null;
  if (S.weather) {
    snap = cloudsAtAz(S.weather.set, m.az, m.t);
    cross = rayLayerCrossings(snap, S.h0, m.el, hit ? hit.d : Infinity);
    if (S.vis[S.tIdx] === 'on') clear = rayClear(snap, S.h0, Math.max(m.el, 0));
  }
  return { ...m, tr, hit, hz, snap, cross, clear, state: S.vis[S.tIdx] };
}

// ---------- rendering ----------
function renderAllEmpty() {
  for (const id of ['pano', 'section', 'timeline']) { const { ctx, w, h } = setupCanvas($(id)); ctx.clearRect(0, 0, w, h); }
  $('verdict').textContent = '—'; $('clouds').textContent = '';
  renderMapDynamic(null);
}

function renderStatic() { drawTimeline(); }

function renderDynamic() {
  const f = currentFrame();
  if (!f) return;
  const tz = S.tz;
  const dMin = Math.round((f.t - S.win.event) / 60000);
  $('tLabel').textContent = `Ora (${dMin >= 0 ? '+' : '−'}${Math.abs(dMin)} min)`;
  $('tTime').textContent = formatLocal(f.t, tz);
  $('tAz').textContent = (((f.az % 360) + 360) % 360).toFixed(1) + '°';
  $('tEl').textContent = fmtDeg(f.el);
  $('tHz').textContent = fmtDeg(f.hz);

  const v = $('vTerrain');
  if (f.state === 'on') {
    v.style.color = 'var(--ok)'; v.style.borderColor = '#2c5a3f';
    v.textContent = `Disco sopra l'orizzonte reale (margine ${(f.el + SUN_SEMIDIAMETER - f.hz).toFixed(2)}°)`;
  } else if (f.state === 'terrain') {
    v.style.color = 'var(--bad)'; v.style.borderColor = '#6a3335';
    const p = f.tr.peak;
    v.textContent = `Dietro il rilievo: cresta a ${(p.d / 1000).toFixed(1)} km (${Math.round(p.h)} m), orizzonte ${fmtDeg(f.hz)}`;
  } else {
    v.style.color = 'var(--muted)'; v.style.borderColor = 'var(--line)';
    v.textContent = 'Sotto l\'orizzonte astronomico: illuminazione solo dal basso delle nubi';
  }
  $('verdict').style.borderColor = v.style.borderColor;
  const vc = $('vCloud');
  vc.textContent = '';
  if (f.state === 'on') {
    if (!S.weather) vc.textContent = S.weatherErr ? `Nubi: ${S.weatherErr}` : 'Nubi: caricamento…';
    else if (f.clear?.P == null) vc.textContent = 'Nubi: nessun dato del modello lungo il raggio';
    else {
      const P = f.clear.P, cls = probClass(P), w = f.clear.worst;
      vc.style.color = cls === 'libero' ? 'var(--ok)' : cls === 'incerto' ? 'var(--amber)' : 'var(--bad)';
      const where = w && w.d < 3000 ? 'sopra di te' : w ? `a ${Math.round(w.d / 1000)} km` : '';
      const why = cls !== 'libero' && w ? ` · nube più densa: ${w.layer.name} ${where} (${Math.round(w.c)}%)` : '';
      vc.textContent = `Nubi: ${cls}, disco visibile ${Math.round(P * 100)}%${why}${f.el < 4 ? ' · sotto 4°: stima estrapolata' : ''}`;
    }
  }

  const lines = [];
  if (S.weatherErr && !S.weather) lines.push(`Nubi: ${S.weatherErr}`);
  if (S.weather) {
    if (f.hit && f.hit.d < 30000) {
      lines.push(`Raggio fermato dal rilievo a ${(f.hit.d / 1000).toFixed(1)} km: le nubi oltre non incidono sul disco.`);
    } else if (!f.cross.length) lines.push('Il raggio non attraversa strati entro 300 km.');
    else for (const c of f.cross) {
      const cov = c.mean == null ? 'n.d. (fuori dominio del modello)' : `media ${Math.round(c.mean)}%, max ${Math.round(c.max)}%`;
      lines.push(`Nubi ${c.layer.name.padEnd(6)} ${String(Math.round(c.from / 1000)).padStart(3)}–${String(Math.round(c.to / 1000)).padStart(3)} km · ${cov}`);
    }
    const ml = MODELS.find((m) => m.id === S.weather.model)?.label ?? S.weather.model;
    const n360 = (a) => (((a % 360) + 360) % 360).toFixed(0);
    const set = S.weather.set;
    const dirTxt = set.length === 1 ? `nubi lungo ${n360(set[0].az)}°`
      : `nubi su ${set.length} direzioni (${set.map((x) => n360(x.az) + '°').join(', ')}), interpolate sull'azimut del Sole`;
    lines.push(`Fonte: ${ml} · ${S.weather.source} · ${dirTxt}`);
  }
  $('clouds').textContent = lines.join('\n');

  drawPano(f); drawSection(f); drawTimelineCursor(f);
  renderMapDynamic(f);
}

// interpolazione continua tra tappe di colore in funzione dell'elevazione solare (solo resa visiva)
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lerpC = (c0, c1, t) => c0.map((v, i) => Math.round(v + (c1[i] - v) * t));
function lerpStops(stops, el) {
  if (el >= stops[0][0]) return stops[0].slice(1);
  for (let i = 1; i < stops.length; i++) if (el >= stops[i][0]) {
    const t = (stops[i - 1][0] - el) / (stops[i - 1][0] - stops[i][0]);
    return stops[i].slice(1).map((c, k) => lerpC(stops[i - 1][k + 1], c, t));
  }
  return stops[stops.length - 1].slice(1);
}
const SKY = [[10, hex('#1d3a5f'), hex('#6b9ac4')], [5, hex('#22385c'), hex('#c99a6a')], [1, hex('#24375a'), hex('#e8a35a')],
  [-1, hex('#20304f'), hex('#df7f5a')], [-3, hex('#1f2a4a'), hex('#d9705a')], [-6, hex('#161d36'), hex('#8c4b62')], [-9, hex('#0b0f1c'), hex('#2a2342')]];
const CLOUD = [[8, [196, 205, 218]], [4, [120, 124, 140]], [1, [70, 74, 92]], [-1, [150, 92, 104]], [-4, [190, 104, 112]], [-8, [70, 52, 70]]];
function skyColors(el) { return lerpStops(SKY, el).map((c) => `rgb(${c.join(',')})`); }

function drawPano(f) {
  const { ctx, w, h } = setupCanvas($('pano'));
  if (!w || !h) return;
  const P = S.profile;
  const a0 = P.azMin, a1 = P.azMax;
  const hzMax = Math.max(...P.prof.map((p) => p.horizon));
  const hzMin = Math.min(...P.prof.map((p) => p.horizon));
  const e0 = Math.min(-1.5, hzMin - 0.6);
  const e1 = Math.max(7, hzMax + 1.5);
  const X = (az) => ((az - a0) / (a1 - a0)) * w;
  const Y = (el) => h - 18 - ((el - e0) / (e1 - e0)) * (h - 26);

  const [top, bottom] = skyColors(f.el);
  const g = ctx.createLinearGradient(0, 0, 0, Y(e0));
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  // orizzonte astronomico
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke(); ctx.setLineDash([]);

  if (S.weather) drawPanoClouds(ctx, f, X, Y, a0, a1, e0, e1, w, h);

  // disco solare (dimensione reale in scala verticale, minimo 3 px).
  // Luminosità continua: frazione del disco sopra il rilievo × probabilità che le nubi lo lascino passare.
  const r = Math.max(3, (SUN_SEMIDIAMETER / (e1 - e0)) * (h - 26));
  const sx = X(f.az), sy = Y(f.el);
  const above = Math.max(0, Math.min(1, (f.el + SUN_SEMIDIAMETER - f.hz) / (2 * SUN_SEMIDIAMETER)));
  const pc = f.clear?.P ?? (S.weather ? 0 : 1);
  const lum = above * (S.weather ? pc : 1);
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 7);
  glow.addColorStop(0, `rgba(255,200,110,${(0.12 + 0.68 * lum).toFixed(3)})`);
  glow.addColorStop(1, 'rgba(255,170,110,0)');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(sx, sy, r * 7, 0, 7); ctx.fill();
  ctx.fillStyle = `rgba(255,217,138,${(0.25 + 0.75 * lum).toFixed(3)})`; ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill();

  // percorso del Sole: un punto per minuto, colorato come la barra temporale
  const pcol = { libero: '#f5a524', incerto: '#c08a3e', bloccato: '#7d8796' };
  S.minutes.forEach((m, i) => {
    if (i % 2 || Math.abs(i - S.tIdx) <= 2) return;     // niente punti sopra il disco
    const v = S.vis[i], cls = v === 'on' && S.probs.length ? probClass(S.probs[i]) : null;
    ctx.fillStyle = cls ? pcol[cls] : v === 'on' ? 'rgba(255,214,140,.8)' : v === 'terrain' ? '#9a4a50' : 'rgba(140,150,170,.5)';
    ctx.beginPath(); ctx.arc(X(m.az), Y(m.el), 1.6, 0, 7); ctx.fill();
  });

  // silhouette per fasce di distanza: lontano chiaro (prospettiva aerea), vicino scuro
  const shades = ['#0d1218', '#1a2330', '#2a3646', '#3f4d60', '#5a6a80'];
  for (let b = BANDS.length - 1; b >= 0; b--) {
    ctx.fillStyle = shades[b];
    ctx.beginPath(); ctx.moveTo(0, h);
    P.prof.forEach((p) => ctx.lineTo(X(p.az), Y(Math.max(e0 - 1, p.bands[b]))));
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  }
  // linea d'orizzonte reale
  ctx.strokeStyle = 'rgba(245,165,36,.55)'; ctx.lineWidth = 1;
  ctx.beginPath();
  P.prof.forEach((p, i) => (i ? ctx.lineTo(X(p.az), Y(p.horizon)) : ctx.moveTo(X(p.az), Y(p.horizon))));
  ctx.stroke();

  // scale
  ctx.fillStyle = 'rgba(230,237,243,.75)'; ctx.font = '10px ui-monospace, Menlo, monospace';
  for (let a = Math.ceil(a0 / 5) * 5; a <= a1; a += 5) {
    ctx.fillText(`${(((a % 360) + 360) % 360)}°`, X(a) - 10, h - 4);
  }
  for (let e = Math.ceil(e0); e <= e1; e += 2) ctx.fillText(`${e > 0 ? '+' : ''}${e}°`, 3, Y(e) + 3);
  $('panoInfo').textContent = `orizzonte max ${fmtDeg(hzMax)} · bande 5/20/60/150/300 km`;
}

/**
 * Nubi ricostruite nel panorama: per ogni direzione (azimut) e angolo di elevazione si percorre la linea di vista
 * nel campo di nubi interpolato e si disegna l'opacità 1 − P con lo stesso modello dei varchi usato per il verdetto.
 * Così il disco solare appare coperto esattamente quanto dice la probabilità.
 */
// rumore a valori con interpolazione morbida e somma frattale (4 ottave), valori in [0,1] con distribuzione ~uniforme
function hash2(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < 4; o++) { s += amp * vnoise(x * f, y * f); norm += amp; amp *= 0.5; f *= 2.03; }
  const v = s / norm;                                   // ~gaussiana attorno a 0,5: si stira verso l'uniforme
  return Math.max(0, Math.min(1, 0.5 + (v - 0.5) * 2.4));
}

function drawPanoClouds(ctx, f, X, Y, a0, a1, e0, e1, w, h) {
  const key = `${S.tIdx}|${w}|${h}|${S.weather.model}`;
  const elBase = Math.max(e0, -1);
  if (!S.cloudCache || S.cloudCache.key !== key) {
    const cols = Math.min(140, Math.round(w / 3)), rows = 80;
    const dAz = (a1 - a0) / cols, dEl = (e1 - elBase) / rows;
    const op = new Float32Array(cols * rows);
    for (let i = 0; i < cols; i++) {
      const az = a0 + (i + 0.5) * dAz;
      const snap = cloudsAtAz(S.weather.set, az, f.t);
      const hz = horizonAt(S.profile, az);
      for (let j = 0; j < rows; j++) {
        const el = e1 - (j + 0.5) * dEl;               // riga 0 = in alto
        if (el < hz - 2 * dEl) continue;               // sotto il rilievo: non si vede
        let Ssum = 0;
        for (let dk = 0; dk <= 230; dk += 3) {
          const z = rayAltitude(dk * 1000, S.h0, el);
          if (z > LAYER_TOP) break;
          if (z < 0) continue;
          const lk = z < 3000 ? 'low' : z < 8000 ? 'mid' : 'high';
          const c = coverAt(snap, dk * 1000, lk);
          if (c != null) Ssum += Math.log(1 - Math.min(c, 99.5) / 100) * 3;
        }
        op[j * cols + i] = 1 - Math.exp(Ssum / GAP_L_KM);
      }
    }
    S.cloudCache = { key, op, cols, rows };
  }
  const { op, cols, rows } = S.cloudCache;
  // colore: nubi illuminate dal basso vicino al tramonto, grigie con Sole alto
  // con Sole basso le nubi davanti al Sole appaiono in controluce (scure); dopo il tramonto si accendono dal basso
  const rgb = lerpStops(CLOUD, f.el)[0];
  const off = Object.assign(document.createElement('canvas'), { width: cols, height: rows });
  const octx = off.getContext('2d');
  const img = octx.createImageData(cols, rows);
  // Resa a "nubi con varchi": un rumore frattale fisso nel cielo viene confrontato con 1 − opacità, così la
  // frazione di cielo disegnata come nube corrisponde all'opacità calcolata. La forma delle nubi è inventata;
  // la quantità e la posizione (dove il raggio incontra copertura) vengono dal modello.
  const az0 = a0, dAzc = (a1 - a0) / cols, dElc = (e1 - elBase) / rows;
  for (let k = 0; k < op.length; k++) {
    const i = k % cols, j = (k / cols) | 0;
    const o = Math.min(1, op[k]);
    if (o < 0.02) continue;
    const n = fbm((az0 + (i + 0.5) * dAzc) / 2.6, (e1 - (j + 0.5) * dElc) / 0.8);
    const edge = 0.12, thr = 1 - o;
    const a = Math.max(0, Math.min(1, (n - thr + edge) / (2 * edge)));
    const shade = 0.82 + 0.18 * n;                       // leggera modulazione interna
    img.data[k * 4] = Math.round(rgb[0] * shade); img.data[k * 4 + 1] = Math.round(rgb[1] * shade); img.data[k * 4 + 2] = Math.round(rgb[2] * shade);
    img.data[k * 4 + 3] = Math.round(a * 0.95 * 255);
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, X(a0), Y(e1), X(a1) - X(a0), Y(elBase) - Y(e1));
}

function drawSection(f) {
  const { ctx, w, h } = setupCanvas($('section'));
  if (!w || !h) return;
  const L = 34, R = 8, T = 8, B = 18;
  const pw = w - L - R, ph = h - T - B;
  const maxKm = 300, maxAlt = 12000;
  const X = (d) => L + (d / 1000 / maxKm) * pw;
  const Y = (z) => T + ph - (Math.min(maxAlt, Math.max(0, z)) / maxAlt) * ph;
  ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#0f151d'; ctx.fillRect(L, T, pw, ph);

  // nubi (celle tra colonne Open-Meteo)
  if (f.snap) {
    const inCross = (key, d0, d1) => f.cross.some((c) => c.layer.key === key && d1 >= c.from && d0 <= c.to);
    for (let i = 0; i < f.snap.length - 1; i++) {
      const c0 = f.snap[i], c1 = f.snap[i + 1];
      for (const Lr of LAYERS) {
        const v0 = c0[Lr.key], v1 = c1[Lr.key];
        if (v0 == null && v1 == null) continue;
        const cov = ((v0 ?? v1) + (v1 ?? v0)) / 200;
        if (cov < 0.03) continue;
        ctx.fillStyle = inCross(Lr.key, c0.d, c1.d)
          ? `rgba(255,190,140,${0.12 + cov * 0.5})` : `rgba(200,212,226,${0.08 + cov * 0.42})`;
        ctx.fillRect(X(c0.d), Y(Math.min(Lr.top, maxAlt)), X(c1.d) - X(c0.d) + 0.5, Y(Lr.bottom) - Y(Math.min(Lr.top, maxAlt)));
      }
    }
  }
  // griglia
  ctx.strokeStyle = '#1f2733'; ctx.lineWidth = 1; ctx.fillStyle = '#8b98a8'; ctx.font = '10px ui-monospace, Menlo, monospace';
  for (const z of [0, 3000, 8000, 12000]) {
    ctx.beginPath(); ctx.moveTo(L, Y(z)); ctx.lineTo(L + pw, Y(z)); ctx.stroke();
    ctx.fillText(`${z / 1000}km`, 2, Y(z) + 3);
  }
  for (let d = 0; d <= maxKm; d += 50) ctx.fillText(`${d}`, X(d * 1000) - 6, h - 5);

  // terreno
  ctx.fillStyle = '#2a3646'; ctx.beginPath(); ctx.moveTo(X(0), Y(0));
  for (const s of f.tr.samples) ctx.lineTo(X(s.d), Y(s.h));
  ctx.lineTo(X(MAX_DIST), Y(0)); ctx.closePath(); ctx.fill();

  // raggio
  const col = f.el > 2 ? '#ffd166' : f.el > -1 ? '#f5a524' : '#f0643c';
  ctx.lineWidth = 2.4; ctx.strokeStyle = col; ctx.beginPath();
  let last = null;
  for (let d = 0; d <= MAX_DIST; d += 1000) {
    if (f.hit && d > f.hit.d) break;
    const z = rayAltitude(d, S.h0, f.el, DEFAULT_K);
    if (z > maxAlt) break;
    last = [X(d), Y(z)];
    d === 0 ? ctx.moveTo(...last) : ctx.lineTo(...last);
  }
  ctx.stroke();
  if (f.hit && last) {
    ctx.fillStyle = '#f2777a'; ctx.beginPath(); ctx.arc(X(f.hit.d), Y(f.hit.h), 4, 0, 7); ctx.fill();
  }
  $('secInfo').textContent = S.weather ? 'celle calde = strati attraversati dal raggio' : 'nubi non ancora caricate';
}

function drawTimeline() {
  const c = $('timeline');
  const { ctx, w, h } = setupCanvas(c);
  if (!c.width || !c.height) { S._tlImage = null; return; }   // pagina nascosta o non ancora impaginata
  ctx.clearRect(0, 0, w, h);
  if (!S.vis.length) return;
  const n = S.vis.length, bw = w / n;
  const col = { on: '#f5a524', terrain: '#5a2f33', below: '#1c2230' };
  const pcol = { libero: '#f5a524', incerto: '#9a6a2c', bloccato: '#4a5566' };
  S.vis.forEach((v, i) => {
    const pc = v === 'on' && S.probs.length ? probClass(S.probs[i]) : null;
    ctx.fillStyle = pc ? pcol[pc] : col[v];
    ctx.fillRect(i * bw, 13, bw + 0.6, h - 26);
  });
  ctx.fillStyle = '#8b98a8'; ctx.font = '10px ui-monospace, Menlo, monospace';
  const tz = S.tz;
  const iEv = S.minutes.findIndex((m) => m.t >= S.win.event);
  const mark = (i, label, color, top) => {
    if (i < 0) return;
    ctx.fillStyle = color; ctx.fillRect(i * bw, top ? 10 : 13, 1.5, h - 23);
    ctx.fillStyle = top ? color : '#8b98a8';
    const tw = ctx.measureText(label).width;
    ctx.textAlign = 'left';
    ctx.fillText(label, Math.min(w - tw - 2, Math.max(2, i * bw - tw / 2)), top ? 9 : h - 1);
  };
  ctx.textAlign = 'left'; ctx.fillText(formatLocal(S.minutes[0].t, tz), 0, h - 1);
  ctx.textAlign = 'right'; ctx.fillText(formatLocal(S.minutes[n - 1].t, tz), w, h - 1);
  // ultimo (tramonto) o primo (alba) minuto con disco visibile sopra il rilievo
  let iVis = -1;
  if (S.type === 'sunset') { for (let i = 0; i < n; i++) if (S.vis[i] === 'on') iVis = i; }
  else iVis = S.vis.indexOf('on');
  if (iVis >= 0) mark(iVis, `${S.type === 'sunset' ? 'ultimo' : 'primo'} raggio ${formatLocal(S.minutes[iVis].t, tz)}`, '#f5a524', true);
  mark(iEv, `${S.type === 'sunset' ? 'tramonto' : 'alba'} ${formatLocal(S.win.event, tz)}`, '#ffffff', false);
  ctx.textAlign = 'left';
  S._tlImage = ctx.getImageData(0, 0, c.width, c.height);
}

function drawTimelineCursor() {
  const c = $('timeline');
  if (!c.width) return;
  if (!S._tlImage || c.width !== S._tlImage.width) { drawTimeline(); if (!S._tlImage) return; }
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(S._tlImage, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = c.width / dpr, n = S.vis.length;
  ctx.fillStyle = '#e6edf3'; ctx.fillRect((S.tIdx + 0.5) * (w / n) - 1, 11, 2, c.height / dpr - 24);
}

// ---------- avvio ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
showCalls();
(async () => {
  const gps = await new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    const timer = setTimeout(() => res(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(timer); res({ lat: p.coords.latitude, lon: p.coords.longitude }); },
      () => { clearTimeout(timer); res(null); },
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 300000 });
  });
  if (gps) { S.phone = gps; S.obs = gps; store.set('obs', gps); map.jumpTo({ center: [gps.lon, gps.lat] }); }
  load();
})();
