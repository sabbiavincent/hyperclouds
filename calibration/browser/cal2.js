// Taratura in browser: le chiamate Open-Meteo partono dal browser che esegue questo modulo.
import { sunPosition } from '../../js/solar.js';
import { rayAltitude, destination } from '../../js/geodesy.js';
import { Dem, browserTileLoader } from '../../js/dem.js';
import { prefetchFan, horizonProfile, horizonAt } from '../../js/terrain.js';

export async function run(ST) {
window.__cal = window.__cal || {};
const TRUTH = await (await fetch(new URL(`./t2_${ST.id}.json`, import.meta.url))).json();
// terreno: profilo d'orizzonte della stazione
const dem = new Dem(browserTileLoader);
const g = await dem.elevation(ST.lat, ST.lon, 13);
const h0 = ST.h + 2;
await prefetchFan(dem, ST, 190, 320, 1);
const hp = horizonProfile(dem, ST, h0, 190, 320, 1);
// nubi: ventaglio 195–315° × 10 distanze, un anno
const AZ = []; for (let a = 195; a <= 315; a += 15) AZ.push(a);
const D = [5, 10, 20, 30, 45, 65, 90, 120, 160, 220];
const pts = [{d: 0, lat: ST.lat, lon: ST.lon}];
for (const az of AZ) for (const d of D) pts.push({az, d, ...destination(ST.lat, ST.lon, d * 1000, az)});
const q = new URLSearchParams({
  latitude: pts.map(p => p.lat.toFixed(4)).join(','), longitude: pts.map(p => p.lon.toFixed(4)).join(','),
  hourly: 'cloud_cover_low,cloud_cover_mid,cloud_cover_high', models: 'icon_d2', timeformat: 'unixtime', timezone: 'GMT',
  start_date: '2025-06-01', end_date: '2026-05-31'});
const r = await fetch('https://historical-forecast-api.open-meteo.com/v1/forecast?' + q);
const j = await r.json();
if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (j && j.reason));
const t0 = j[0].hourly.time[0] * 1000, NT = j[0].hourly.time.length;
const K = ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'];
const DD = [0, ...D];
const series = (li, ai, k) => j[k === 0 ? 0 : 1 + ai * D.length + k - 1].hourly[K[li]];
const tval = (arr, t) => { const f = (t - t0) / 3600000, i = Math.floor(f); if (i < 0 || i + 1 >= NT) return null;
  const a = arr[i], b = arr[i + 1]; if (a == null || b == null) return a ?? b; return a + (b - a) * (f - i); };
const mix = (x, y, f) => (x == null ? y : y == null ? x : x + (y - x) * f);
function cover(li, dkm, az, t) {
  let k = DD.findIndex(x => x >= dkm); if (k <= 0) k = 1; if (k === -1) k = DD.length - 1;
  const fd = Math.min(1, Math.max(0, (dkm - DD[k - 1]) / (DD[k] - DD[k - 1])));
  let a = AZ.findIndex(x => x >= az), a0, a1, fa;
  if (a <= 0) { a0 = a1 = 0; fa = 0; } else if (a === -1) { a0 = a1 = AZ.length - 1; fa = 0; } else { a0 = a - 1; a1 = a; fa = (az - AZ[a0]) / 15; }
  const v0 = mix(tval(series(li, a0, k - 1), t), tval(series(li, a0, k), t), fd);
  const v1 = mix(tval(series(li, a1, k - 1), t), tval(series(li, a1, k), t), fd);
  return mix(v0, v1, fa);
}
// varianti di geometria degli strati: [base_basse, cima_basse, base_medie, base_alte]
const V = [];
for (const lb of [0, 300, 600, 1000, 1500, 2000]) for (const lt of [2000, 3000]) for (const mb of [3000, 4000, 5000]) for (const hb of [8000, 9500])
  if (lb < lt) V.push([lb, lt, mb, hb]);
const steps = []; for (let d = 0; d <= 220; d += 2) steps.push(d);
const sun = [], els = [], Sall = [];
let skippedTerrain = 0;
for (let i = 0; i < TRUTH.length; i += 2) {
  const tc = TRUTH[i] * 60000;
  const s = sunPosition(tc, ST.lat, ST.lon);
  if (s.el < horizonAt(hp, s.az) + 1) { skippedTerrain++; continue; }
  const zs = [], cs = [];
  for (const d of steps) {
    const z = rayAltitude(d * 1000, h0, s.el);
    if (z > 13000) break;
    zs.push(z); cs.push([cover(0, d, s.az, tc), cover(1, d, s.az, tc), cover(2, d, s.az, tc)]);
  }
  const Sv = new Float32Array(V.length);
  V.forEach(([lb, lt, mb, hb], v) => {
    let S = 0;
    for (let k = 0; k < zs.length; k++) {
      const z = zs[k]; let c = null;
      if (z >= lb && z < lt) c = cs[k][0]; else if (z >= mb && z < 8000) c = cs[k][1]; else if (z >= hb) c = cs[k][2];
      if (c != null) S += Math.log(1 - Math.min(c, 99.5) / 100) * 2;
    }
    Sv[v] = S;
  });
  sun.push(TRUTH[i + 1]); els.push(s.el); Sall.push(Sv);
}
window.__cal[ST.id] = {sun, els, Sall, V};
return ({station: ST.id, ground: Math.round(g), intervals: sun.length, skippedTerrain, hzMax: Math.max(...hp.prof.map(p => p.horizon)).toFixed(2), variants: V.length})
}

// Valutazione: per ogni variante si sceglie L (Brier minimo) su Sole >= minEl; validazione lasciando fuori una stazione.
export function evaluate(ids, minEl = 4) {
  const C = window.__cal, V = C[ids[0]].V, Ls = [5, 10, 15, 20, 30, 40, 50, 60, 80, 100, 150, 220];
  const rows = (id) => C[id].sun.map((s, i) => i).filter((i) => C[id].els[i] >= minEl);
  const brier = (sets, v, L) => { let e = 0, n = 0; for (const id of sets) for (const i of rows(id)) { const p = Math.exp(C[id].Sall[i][v] / L); e += (p - C[id].sun[i]) ** 2; n++; } return e / n; };
  const clim = (sets) => { let s = 0, n = 0; for (const id of sets) for (const i of rows(id)) { s += C[id].sun[i]; n++; } const p = s / n; let e = 0; for (const id of sets) for (const i of rows(id)) e += (p - C[id].sun[i]) ** 2; return e / n; };
  const bc = clim(ids);
  const res = V.map((g, v) => {
    let best = null; for (const L of Ls) { const b = brier(ids, v, L); if (!best || b < best.b) best = { L, b }; }
    // leave-one-station-out
    let cv = [];
    for (const out of ids) { const tr = ids.filter((x) => x !== out); let bl = null;
      for (const L of Ls) { const b = brier(tr, v, L); if (!bl || b < bl.b) bl = { L, b }; }
      cv.push(1 - brier([out], v, bl.L) / clim([out])); }
    return { geom: g, L: best.L, brier: +best.b.toFixed(4), skill: +(1 - best.b / bc).toFixed(3), cvSkill: +(cv.reduce((a, b) => a + b, 0) / cv.length).toFixed(3), cvPer: cv.map((x) => +x.toFixed(3)) };
  });
  res.sort((a, b) => b.cvSkill - a.cvSkill);
  const base = res.find((r) => r.geom.join() === '0,3000,3000,8000');
  return { n: ids.map((id) => rows(id).length), climBrier: +bc.toFixed(4), baseline: base, top: res.slice(0, 8), worst: res.slice(-3) };
}
