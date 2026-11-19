const {sunPosition} = await import('/hyperclouds/js/solar.js');
const {rayAltitude, destination} = await import('/hyperclouds/js/geodesy.js');
window.__feat = window.__feat || {};
const ST = __ST__;
const AZ = []; for (let a = 195; a <= 315; a += 15) AZ.push(a);
const D = [5, 10, 20, 30, 45, 65, 90, 120, 160, 220];
const pts = [{az: null, d: 0, lat: ST.lat, lon: ST.lon}];
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
const grid = (li, ai, di) => j[di === -1 ? 0 : 1 + ai * D.length + di].hourly[K[li]];
const tval = (arr, t) => { const f = (t - t0) / 3600000, i = Math.floor(f); if (i < 0 || i + 1 >= NT) return null;
  const a = arr[i], b = arr[i + 1]; if (a == null || b == null) return a ?? b; return a + (b - a) * (f - i); };
const azLine = (az) => { let k = AZ.findIndex(x => x >= az); if (k <= 0) return [0, 0, 0]; if (k === -1) return [AZ.length - 1, AZ.length - 1, 0];
  return [k - 1, k, (az - AZ[k - 1]) / 15]; };
function cover(li, dkm, az, t) {
  const [a0, a1, fa] = azLine(az);
  const DD = [0, ...D];
  let k = DD.findIndex(x => x >= dkm); if (k <= 0) k = 1; if (k === -1) k = DD.length - 1;
  const fd = Math.min(1, Math.max(0, (dkm - DD[k - 1]) / (DD[k] - DD[k - 1])));
  const at = (ai, di) => tval(grid(li, ai, di - 1), t);
  const mix = (x, y, f) => (x == null ? y : y == null ? x : x + (y - x) * f);
  const v0 = mix(at(a0, k - 1), at(a0, k), fd), v1 = mix(at(a1, k - 1), at(a1, k), fd);
  return mix(v0, v1, fa);
}
const out = [];
const start = Date.UTC(2025, 5, 1, 0, 10), end = Date.UTC(2026, 5, 1);
for (let tEnd = start; tEnd < end; tEnd += 600000) {
  const tc = tEnd - 300000;
  const s = sunPosition(tc, ST.lat, ST.lon), s2 = sunPosition(tc + 60000, ST.lat, ST.lon);
  if (s2.el >= s.el || s.el < 2 || s.el > 10) continue;
  let maxC = 0, S = 0, mx = [0, 0, 0], n = 0;
  for (let d = 0; d <= 220; d += 2) {
    const z = rayAltitude(d * 1000, ST.h, s.el);
    if (z > 13000) break;
    const li = z < 3000 ? 0 : z < 8000 ? 1 : 2;
    const c = cover(li, d, s.az, tc);
    if (c == null) continue;
    n++; maxC = Math.max(maxC, c); mx[li] = Math.max(mx[li], c);
    S += Math.log(1 - Math.min(c, 99.5) / 100) * 2;
  }
  const loc = [0, 1, 2].map(li => tval(grid(li, 0, -1), tc));
  out.push([Math.round(tc / 60000), +maxC.toFixed(1), +S.toFixed(2), ...loc.map(v => v == null ? -1 : Math.round(v)), ...mx.map(v => Math.round(v)), n]);
}
window.__feat[ST.id] = out;
({station: ST.id, rows: out.length, nullHours: j[1].hourly.cloud_cover_low.filter(v => v == null).length, NT})
