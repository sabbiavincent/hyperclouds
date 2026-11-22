// Open-Meteo: metadati del luogo (fuso, quota) e nuvolosità a strati lungo il transetto solare.
// Strati Open-Meteo: basse fino a ~3 km, medie 3–8 km, alte oltre 8 km.

import { destination, rayAltitude, DEFAULT_K } from './geodesy.js';

export const LAYERS = [
  { key: 'low', name: 'basse', bottom: 0, top: 3000 },
  { key: 'mid', name: 'medie', bottom: 3000, top: 8000 },
  { key: 'high', name: 'alte', bottom: 8000, top: 13000 },
];

export const MODELS = [
  { id: 'best_match', label: 'Automatico (migliore disponibile)' },
  { id: 'icon_seamless', label: 'ICON combinato (D2 → EU → globale)' },
  { id: 'icon_d2', label: 'ICON-D2 2,2 km (Europa centrale, 48 h)' },
  { id: 'icon_eu', label: 'ICON-EU 7 km (Europa)' },
  { id: 'meteofrance_seamless', label: 'Météo-France AROME/ARPEGE' },
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS 0,25° (globale)' },
  { id: 'gfs_seamless', label: 'NOAA GFS (globale)' },
];

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const HISTORICAL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';

// ---- Contatore approssimato delle chiamate Open-Meteo (peso = punti × ⌈giorni/14⌉ × ⌈variabili/10⌉) ----
export const DAILY_LIMIT = 10000;
const utcDay = () => new Date().toISOString().slice(0, 10);
export function callCount() {
  try { const c = JSON.parse(localStorage.getItem('hc.calls') || 'null'); return c && c.day === utcDay() ? c.n : 0; } catch { return 0; }
}
function countCall(url) {
  try {
    const q = new URL(url).searchParams;
    const nLoc = (q.get('latitude') || '').split(',').length;
    let days = +(q.get('forecast_days') || 0);
    if (q.get('start_date') && q.get('end_date')) days = (Date.parse(q.get('end_date')) - Date.parse(q.get('start_date'))) / 86400000 + 1;
    const nVar = ['hourly', 'daily', 'current'].reduce((a, k) => a + (q.get(k) ? q.get(k).split(',').length : 0), 0);
    const w = nLoc * Math.max(1, Math.ceil(days / 14)) * Math.max(1, Math.ceil(nVar / 10));
    localStorage.setItem('hc.calls', JSON.stringify({ day: utcDay(), n: callCount() + w }));
  } catch {}
}

async function getJson(url) {
  countCall(url);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
  let r;
  try { r = await fetch(url, { signal: ctl.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'Open-Meteo non risponde (25 s)' : `rete: ${e.message}`); }
  finally { clearTimeout(timer); }
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 429) throw new Error(`limite di chiamate Open-Meteo superato (${j?.reason || '429'}): riprova più tardi`);
    throw new Error(j?.reason || `HTTP ${r.status}`);
  }
  return j;
}

/** Fuso orario IANA e quota del punto (da Open-Meteo). */
export async function fetchMeta(lat, lon) {
  const u = `${FORECAST}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&timezone=auto&forecast_days=1&daily=sunrise,sunset`;
  const j = await getJson(u);
  return { tz: j.timezone, elevation: j.elevation, sunrise: j.daily?.sunrise?.[0], sunset: j.daily?.sunset?.[0] };
}

const shiftDate = (s, days) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Nuvolosità oraria (basse/medie/alte) su n punti lungo az, per il giorno locale dateStr (±1 giorno in UTC).
 * Usa l'API previsionale per date recenti/future, l'archivio delle previsioni per il passato.
 */
export async function fetchTransectClouds(obs, az, dateStr, model = 'best_match', n = 31, maxDist = 300000) {
  const pts = Array.from({ length: n }, (_, i) => {
    const d = (i * maxDist) / (n - 1);
    return { d, ...destination(obs.lat, obs.lon, d, az) };
  });
  const q = new URLSearchParams({
    latitude: pts.map((p) => p.lat.toFixed(4)).join(','),
    longitude: pts.map((p) => p.lon.toFixed(4)).join(','),
    hourly: 'cloud_cover_low,cloud_cover_mid,cloud_cover_high',
    timeformat: 'unixtime',
    timezone: 'GMT',
    start_date: shiftDate(dateStr, -1),
    end_date: shiftDate(dateStr, 1),
  });
  if (model !== 'best_match') q.set('models', model);
  const ageDays = (Date.now() - Date.parse(dateStr + 'T00:00:00Z')) / 86400000;
  const hosts = ageDays > 60 ? [[HISTORICAL, 'archivio previsioni']] : [[FORECAST, 'previsione'], [HISTORICAL, 'archivio previsioni']];
  let arr = null, source = '', partial = 0, lastErr = null;
  for (const [host, label] of hosts) {
    try {
      const j = await getJson(`${host}?${q}`);
      arr = Array.isArray(j) ? j : [j]; source = label; break;
    } catch (e) {
      lastErr = e;
      // Il modello rifiuta l'intera richiesta se alcuni punti sono fuori dominio: si chiede punto per punto.
      if (/no data/i.test(e.message)) {
        const one = await Promise.allSettled(pts.map((p) => {
          const q1 = new URLSearchParams(q);
          q1.set('latitude', p.lat.toFixed(4)); q1.set('longitude', p.lon.toFixed(4));
          return getJson(`${host}?${q1}`).then((v) => (Array.isArray(v) ? v[0] : v));
        }));
        const ok = one.find((r) => r.status === 'fulfilled');
        if (ok) {
          const times = ok.value.hourly.time, nul = times.map(() => null);
          partial = one.filter((r) => r.status !== 'fulfilled').length;
          arr = one.map((r) => (r.status === 'fulfilled' ? r.value
            : { hourly: { time: times, cloud_cover_low: nul, cloud_cover_mid: nul, cloud_cover_high: nul } }));
          source = label; break;
        }
      }
    }
  }
  if (!arr) throw lastErr;
  if (partial) source += ` · ${partial}/${n} punti fuori dominio`;
  const cols = arr.map((loc, i) => ({
    d: pts[i].d, lat: pts[i].lat, lon: pts[i].lon,
    times: loc.hourly.time.map((t) => t * 1000),
    low: loc.hourly.cloud_cover_low, mid: loc.hourly.cloud_cover_mid, high: loc.hourly.cloud_cover_high,
  }));
  return { az, model, source, cols };
}

/** Copertura (%) delle tre fasce per ciascuna colonna all'istante t (interpolazione lineare oraria). */
export function cloudsAt(data, t) {
  return data.cols.map((c) => {
    const ts = c.times;
    let i = ts.findIndex((x) => x > t);
    if (i <= 0) i = i === 0 ? 1 : ts.length - 1;
    const a = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
    const lerp = (arr) => {
      const v0 = arr[i - 1], v1 = arr[i];
      if (v0 == null && v1 == null) return null;
      if (v0 == null) return v1;
      if (v1 == null) return v0;
      return v0 * (1 - Math.max(0, Math.min(1, a))) + v1 * Math.max(0, Math.min(1, a));
    };
    return { d: c.d, low: lerp(c.low), mid: lerp(c.mid), high: lerp(c.high) };
  });
}

/**
 * Nubi interpolate in azimut: `set` = [{az, data}] ordinato per az (unwrapped), una per direzione scaricata.
 * Per ogni colonna (stessa distanza) si interpola linearmente tra le due direzioni che racchiudono az.
 */
export function cloudsAtAz(set, az, t) {
  if (set.length === 1) return cloudsAt(set[0].data, t);
  let i = set.findIndex((s) => s.az >= az);
  if (i === -1) return cloudsAt(set[set.length - 1].data, t);
  if (i === 0) return cloudsAt(set[0].data, t);
  const A = cloudsAt(set[i - 1].data, t), B = cloudsAt(set[i].data, t);
  const f = (az - set[i - 1].az) / (set[i].az - set[i - 1].az);
  const mix = (a, b) => (a == null ? b : b == null ? a : a * (1 - f) + b * f);
  return A.map((c, k) => ({ d: c.d, low: mix(c.low, B[k].low), mid: mix(c.mid, B[k].mid), high: mix(c.high, B[k].high) }));
}

export function coverAt(snap, d, key) {
  if (d <= snap[0].d) return snap[0][key];
  for (let i = 1; i < snap.length; i++) {
    if (d <= snap[i].d) {
      const a = (d - snap[i - 1].d) / (snap[i].d - snap[i - 1].d);
      const v0 = snap[i - 1][key], v1 = snap[i][key];
      if (v0 == null || v1 == null) return v0 ?? v1;
      return v0 * (1 - a) + v1 * a;
    }
  }
  return snap[snap.length - 1][key];
}

/**
 * Tratti in cui il raggio (elevazione el) attraversa ciascuna fascia, fino all'eventuale impatto col terreno.
 * Restituisce [{layer, from, to, mean, max}] con distanze in m e coperture in %.
 */
export function rayLayerCrossings(snap, h0, el, stopDist = Infinity, k = DEFAULT_K, maxDist = 300000) {
  const out = [];
  for (const L of LAYERS) {
    let from = null, to = null, sum = 0, n = 0, max = 0;
    for (let d = 0; d <= Math.min(maxDist, stopDist); d += 2000) {
      const z = rayAltitude(d, h0, el, k);
      if (z >= L.bottom && z < L.top) {
        const c = coverAt(snap, d, L.key);
        if (from == null) from = d;
        to = d;
        if (c != null) { sum += c; n++; max = Math.max(max, c); }
      } else if (from != null && z >= L.top) break;
    }
    if (from != null) out.push({ layer: L, from, to, mean: n ? sum / n : null, max });
  }
  return out;
}

// ---- Probabilità che il disco sia visibile (modello dei varchi, tarato su stazioni DWD) ----
// P = exp( Σ ln(1 − c_i) · Δd / L ), con c_i copertura dello strato attraversato dal raggio.
// Taratura: Norderney + Lindenberg, giu 2025 – mag 2026, ICON-D2, Sole 4–10°: L ≈ 50 km (validazione incrociata 50–60 km).
export const GAP_L_KM = 50;
export const LAYER_TOP = 13000;
export function rayClear(snap, h0, el, stopDist = Infinity, k = DEFAULT_K, stepKm = 2, maxKm = 230) {
  let S = 0, n = 0, worst = null;
  for (let dk = 0; dk <= maxKm; dk += stepKm) {
    const d = dk * 1000;
    if (d > stopDist) break;
    const z = rayAltitude(d, h0, el, k);
    if (z > LAYER_TOP) break;
    if (z < 0) continue;
    const L = z < 3000 ? LAYERS[0] : z < 8000 ? LAYERS[1] : LAYERS[2];
    const c = coverAt(snap, d, L.key);
    if (c == null) continue;
    n++;
    S += Math.log(1 - Math.min(c, 99.5) / 100) * stepKm;
    if (!worst || c > worst.c) worst = { layer: L, d, c };
  }
  return { P: n ? Math.exp(S / GAP_L_KM) : null, worst, n };
}

// ---- Pioggia sul posto: precipitazione oraria e probabilità (modello automatico di Open-Meteo) ----
// Richiesta separata e piccola (1 punto): se fallisce, nubi e verdetto non ne risentono.
export async function fetchRain(obs, dateStr) {
  const q = new URLSearchParams({
    latitude: obs.lat.toFixed(4), longitude: obs.lon.toFixed(4),
    hourly: 'precipitation,precipitation_probability', timeformat: 'unixtime', timezone: 'GMT',
    start_date: shiftDate(dateStr, -1), end_date: shiftDate(dateStr, 1),
  });
  const ageDays = (Date.now() - Date.parse(dateStr + 'T00:00:00Z')) / 86400000;
  let j;
  try {
    if (ageDays > 60) throw new Error('archivio');
    j = await getJson(`${FORECAST}?${q}`);
  } catch {
    j = await getJson(`${HISTORICAL}?${q}`);
  }
  if (Array.isArray(j)) j = j[0];
  return { times: j.hourly.time.map((t) => t * 1000), mm: j.hourly.precipitation, prob: j.hourly.precipitation_probability || [] };
}

/** Pioggia nell'ora che contiene t (in Open-Meteo il valore orario è la somma dell'ora che termina a quell'istante). */
export function rainAt(rain, t) {
  if (!rain) return null;
  const i = rain.times.findIndex((x) => x >= t);
  if (i < 0) return null;
  return { mm: rain.mm[i], prob: rain.prob[i] ?? null, end: rain.times[i] };
}
