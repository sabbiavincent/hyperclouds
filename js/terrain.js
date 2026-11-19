// Transetti altimetrici e profilo d'orizzonte reale (con curvatura e rifrazione terrestre).

import { destination, elevationAngle, rayAltitude, DEFAULT_K } from './geodesy.js';

export const MAX_DIST = 300000;
// Campo vicino escluso: a 50 m un errore di quota di 1,5 m (rumore DEM, edifici, alberi) vale già 1,7°.
// A 500 m lo stesso errore vale 0,17°. L'ambiente immediato lo vede l'osservatore.
export const MIN_DIST = 500;

// Passo e risoluzione DEM in funzione della distanza: dettaglio vicino, economia lontano.
function schedule(maxDist = MAX_DIST) {
  const out = [];
  let d = MIN_DIST;
  while (d <= maxDist) {
    const z = d < 15000 ? 12 : d < 60000 ? 11 : 10;
    out.push({ d, z });
    d += d < 5000 ? 50 : d < 20000 ? 100 : d < 80000 ? 250 : 500;
  }
  return out;
}
const SCHED = schedule();

// Fasce di distanza per le silhouette del panorama (prospettiva aerea)
export const BANDS = [
  { name: '0–5 km', max: 5000 },
  { name: '5–20 km', max: 20000 },
  { name: '20–60 km', max: 60000 },
  { name: '60–150 km', max: 150000 },
  { name: '150–300 km', max: 300000 },
];

export function transectPoints(obs, az) {
  return SCHED.map(({ d, z }) => ({ d, z, ...destination(obs.lat, obs.lon, d, az) }));
}

export async function prefetchFan(dem, obs, azMin, azMax, step, onProgress) {
  const pts = [];
  for (let az = azMin; az <= azMax + 1e-9; az += step) {
    for (const p of transectPoints(obs, az)) pts.push(p);
  }
  return dem.prefetch(pts, onProgress);
}

/** Transetto lungo az: campioni {d, lat, lon, h, ang} con ang = angolo apparente del punto. */
export function transect(dem, obs, h0, az, k = DEFAULT_K) {
  const pts = transectPoints(obs, az);
  let missing = 0;
  const samples = pts.map((p) => {
    let h = dem.sample(p.lat, p.lon, p.z);
    if (h == null) { missing++; h = 0; }
    return { d: p.d, lat: p.lat, lon: p.lon, h, ang: elevationAngle(p.d, h0, h, k) };
  });
  let maxAng = -90, peak = null;
  for (const s of samples) if (s.ang > maxAng) { maxAng = s.ang; peak = s; }
  return { az, h0, samples, horizon: maxAng, peak, missing };
}

/** Profilo d'orizzonte su un ventaglio di azimut, con massimi per fascia di distanza. */
export function horizonProfile(dem, obs, h0, azMin, azMax, step, k = DEFAULT_K) {
  const prof = [];
  let missing = 0;
  for (let az = azMin; az <= azMax + 1e-9; az += step) {
    const tr = transect(dem, obs, h0, az, k);
    missing += tr.missing;
    const bands = BANDS.map(() => -90);
    for (const s of tr.samples) {
      const bi = BANDS.findIndex((b) => s.d <= b.max);
      if (bi >= 0 && s.ang > bands[bi]) bands[bi] = s.ang;
    }
    prof.push({ az, horizon: tr.horizon, peak: tr.peak, bands });
  }
  return { prof, azMin, azMax, step, missing };
}

export function horizonAt(profile, az) {
  const { prof, azMin, step } = profile;
  const f = (az - azMin) / step;
  const i = Math.floor(f);
  if (i < 0) return prof[0].horizon;
  if (i >= prof.length - 1) return prof[prof.length - 1].horizon;
  const t = f - i;
  return prof[i].horizon * (1 - t) + prof[i + 1].horizon * t;
}

/** Primo campione del transetto che intercetta il raggio di elevazione apparente el. */
export function rayTerrainHit(tr, el, k = DEFAULT_K) {
  for (const s of tr.samples) {
    if (s.h >= rayAltitude(s.d, tr.h0, el, k)) return s;
  }
  return null;
}
