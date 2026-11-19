import fs from 'fs';
import { sunPosition } from '../js/solar.js';
const ST = { '03631': [53.7123, 7.1519, 12, 'Norderney'], '03015': [52.2085, 14.1180, 98, 'Lindenberg'] };
const out = {};
for (const [id, [lat, lon, h, name]] of Object.entries(ST)) {
  const f = fs.readdirSync(`dwd/st_${id}`).find((x) => x.startsWith('produkt'));
  const lines = fs.readFileSync(`dwd/st_${id}/${f}`, 'utf8').trim().split('\n').slice(1);
  const rows = [];
  for (const L of lines) {
    const p = L.split(';').map((x) => x.trim());
    const ts = p[1], sd = +p[5];
    if (sd < 0) continue;
    const tEnd = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12));
    if (tEnd < Date.UTC(2025, 5, 1) || tEnd >= Date.UTC(2026, 5, 1)) continue;
    const tc = tEnd - 5 * 60000;
    const s = sunPosition(tc, lat, lon), s2 = sunPosition(tc + 60000, lat, lon);
    if (s2.el >= s.el) continue;                 // solo sera (Sole in discesa)
    if (s.el < 2 || s.el > 14) continue;
    rows.push([Math.round(tc / 60000), +s.el.toFixed(3), +s.az.toFixed(2), +(sd * 60).toFixed(1)]); // minuti di sole su 10
  }
  out[id] = { lat, lon, h, name, rows };
  console.log(id, name, rows.length, 'intervalli; az', Math.min(...rows.map(r=>r[2])).toFixed(0), '-', Math.max(...rows.map(r=>r[2])).toFixed(0));
}
fs.writeFileSync('rows.json', JSON.stringify(out));
