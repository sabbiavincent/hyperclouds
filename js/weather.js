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

async function getJson(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.reason || `HTTP ${r.status}`);
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

function coverAt(snap, d, key) {
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
