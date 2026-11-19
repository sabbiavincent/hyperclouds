// Test numerici contro riferimenti indipendenti:
// - effemeridi: astronomy-engine (VSOP87, indipendente dal NOAA)
// - DEM: quote ufficiali di vette note
// - geometria: formule chiuse

import * as Astro from 'astronomy-engine';
import { PNG } from 'pngjs';
import { sunPosition, eventWindow, zonedDayStart, tzOffsetMs, formatLocal } from '../js/solar.js';
import { elevationAngle, rayAltitude, effR, horizonDistanceToLayer } from '../js/geodesy.js';
import { Dem, TERRARIUM_URL, decodePng } from '../js/dem.js';
import { horizonProfile, prefetchFan } from '../js/terrain.js';

let fails = 0, passes = 0;
const check = (name, ok, info = '') => {
  if (ok) passes++; else fails++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${info}`);
};

// ---------- 1. Posizione del Sole vs astronomy-engine ----------
{
  const sites = [[43.7629, 11.2650], [60.39, 5.32], [-33.87, 151.21], [19.43, -99.13], [69.65, 18.96]];
  let maxEl = 0, maxAz = 0, n = 0;
  for (const [lat, lon] of sites) {
    const obs = new Astro.Observer(lat, lon, 0);
    for (let k = 0; k < 400; k++) {
      const ms = Date.UTC(2020, 0, 1) + k * 9.13 * 86400000 + (k * 3571 % 86400) * 1000;
      const date = new Date(ms);
      const eq = Astro.Equator(Astro.Body.Sun, date, obs, true, true);
      const hor = Astro.Horizon(date, obs, eq.ra, eq.dec, null);
      if (hor.altitude < 1) continue;
      const p = sunPosition(ms, lat, lon);
      maxEl = Math.max(maxEl, Math.abs(p.elGeo - hor.altitude));
      let dAz = Math.abs(p.az - hor.azimuth); dAz = Math.min(dAz, 360 - dAz) * Math.cos(hor.altitude * Math.PI / 180);
      if (hor.altitude < 85) maxAz = Math.max(maxAz, dAz);
      n++;
    }
  }
  check('elevazione geometrica (|Δ| max < 0.03°)', maxEl < 0.03, `Δ=${maxEl.toFixed(4)}° su ${n} casi`);
  check('azimut × cos(elev) (|Δ| max < 0.03°)', maxAz < 0.03, `Δ=${maxAz.toFixed(4)}°`);
}

// ---------- 2. Alba / tramonto vs astronomy-engine ----------
{
  const cases = [
    ['Firenze', 43.7629, 11.2650, 'Europe/Rome'],
    ['Bergen', 60.39, 5.32, 'Europe/Oslo'],
    ['Sydney', -33.87, 151.21, 'Australia/Sydney'],
    ['Quito', -0.18, -78.47, 'America/Guayaquil'],
  ];
  const dates = ['2026-01-15', '2026-03-21', '2026-06-21', '2026-09-23', '2026-11-19', '2026-12-21'];
  let maxDiff = 0;
  for (const [name, lat, lon, tz] of cases) {
    const obs = new Astro.Observer(lat, lon, 0);
    for (const ds of dates) {
      const day0 = zonedDayStart(ds, tz);
      for (const type of ['sunrise', 'sunset']) {
        const w = eventWindow(day0, lat, lon, type);
        if (!w.ok) continue;
        const ref = Astro.SearchRiseSet(Astro.Body.Sun, obs, type === 'sunrise' ? +1 : -1, new Date(day0), 1);
        const diff = Math.abs(w.event - ref.date.getTime()) / 60000;
        maxDiff = Math.max(maxDiff, diff);
        if (diff > 1.5) console.log(`   ${name} ${ds} ${type}: ${formatLocal(w.event, tz)} vs ${formatLocal(ref.date.getTime(), tz)}`);
      }
    }
  }
  check('istante alba/tramonto (|Δ| max < 1.5 min)', maxDiff < 1.5, `Δ=${maxDiff.toFixed(2)} min`);
}

// ---------- 3. Finestra adattiva e casi polari ----------
{
  const tz = 'Europe/Rome';
  const w = eventWindow(zonedDayStart('2026-11-19', tz), 43.7629, 11.265, 'sunset');
  const len = (w.end - w.start) / 60000;
  check('Firenze 19/11 finestra +6°..−6° plausibile (55–90 min)', w.ok && len > 55 && len < 90,
    `${formatLocal(w.start, tz)}–${formatLocal(w.end, tz)}, tramonto ${formatLocal(w.event, tz)}`);
  const tr = eventWindow(zonedDayStart('2026-06-21', 'Europe/Oslo'), 69.65, 18.96, 'sunset');
  check('Tromsø 21/06: sole di mezzanotte riconosciuto', !tr.ok, tr.reason || '');
  const ns = eventWindow(zonedDayStart('2026-12-21', 'Europe/Oslo'), 69.65, 18.96, 'sunrise');
  check('Tromsø 21/12: notte polare riconosciuta', !ns.ok, ns.reason || '');
  const be = eventWindow(zonedDayStart('2026-06-21', 'Europe/Oslo'), 63.43, 10.39, 'sunset');
  check('Trondheim 21/06: finestra estesa con nota (il Sole non scende a −6°)', be.ok && be.notes.length > 0,
    `${formatLocal(be.start, 'Europe/Oslo')}–${formatLocal(be.end, 'Europe/Oslo')} ${be.notes.join('; ')}`);
}

// ---------- 4. Fusi orari ----------
{
  check('offset Roma inverno = +60 min', tzOffsetMs(Date.UTC(2026, 0, 15, 12), 'Europe/Rome') === 3600000);
  check('offset Roma estate = +120 min', tzOffsetMs(Date.UTC(2026, 6, 15, 12), 'Europe/Rome') === 7200000);
  check('mezzanotte locale Roma 2026-03-29 (giorno del cambio ora)',
    zonedDayStart('2026-03-29', 'Europe/Rome') === Date.UTC(2026, 2, 28, 23));
}

// ---------- 5. Geometria ----------
{
  const d = 100000;
  const ang = elevationAngle(d, 0, 0, 0.13);
  const expected = -(d / (2 * effR(0.13))) * 180 / Math.PI;
  check('depressione di un punto a quota 0 a 100 km', Math.abs(ang - expected) < 0.002,
    `${ang.toFixed(4)}° vs ${expected.toFixed(4)}°`);
  const z = rayAltitude(200000, 0, 0, 0.13);
  check('quota raggio orizzontale a 200 km ≈ d²/2R_eff', Math.abs(z - 200000 ** 2 / (2 * effR(0.13))) < 15, `${z.toFixed(0)} m`);
  const dl = horizonDistanceToLayer(40, 2000) / 1000;
  check('orizzonte di uno strato a 2 km da 40 m s.l.m. (cfr. NimbuScope 160–230 km per le medie)', dl > 150 && dl < 220, `${dl.toFixed(0)} km`);
}

// ---------- 6. DEM vs vette note (richiede rete verso S3) ----------
const nodeLoader = async (z, x, y) => {
  const r = await fetch(TERRARIUM_URL(z, x, y));
  if (!r.ok) throw new Error(r.status);
  const png = PNG.sync.read(Buffer.from(await r.arrayBuffer()));
  return { width: png.width, height: png.height, data: png.data };
};
{
  const dem = new Dem(nodeLoader);
  const peaks = [
    ['Monte Cimone', 44.1936, 10.7011, 2165],
    ['Monte Amiata', 42.8869, 11.6236, 1738],
    ['Monte Bianco', 45.8326, 6.8652, 4806],
    ['Piazza della Signoria', 43.7696, 11.2558, 50],
  ];
  for (const [name, lat, lon, ref] of peaks) {
    const h = await dem.elevation(lat, lon, 13);
    // le vette sono sottostimate dalla media sul pixel: tolleranza asimmetrica
    check(`DEM ${name} (${ref} m)`, h != null && h > ref - 90 && h < ref + 30, `${h?.toFixed(0)} m`);
  }

  // ---------- 7. Profilo d'orizzonte: Firenze verso ovest al tramonto invernale ----------
  const obs = { lat: 43.7629, lon: 11.265 };
  const h0 = (await dem.elevation(obs.lat, obs.lon, 13)) + 2;
  const t0 = Date.now();
  await prefetchFan(dem, obs, 230, 250, 1);
  const hp = horizonProfile(dem, obs, h0, 230, 250, 1);
  const best = hp.prof.reduce((a, b) => (b.horizon > a.horizon ? b : a));
  check('profilo d\'orizzonte calcolato senza tile mancanti', hp.missing === 0,
    `${hp.prof.length} azimut, ${dem.tiles.size} tile, ${((Date.now() - t0) / 1000).toFixed(1)} s; orizzonte max ${best.horizon.toFixed(2)}° a az ${best.az}° (${(best.peak.d / 1000).toFixed(1)} km, ${best.peak.h.toFixed(0)} m)`);
}

// ---------- 8. Decodifica PNG pura (senza canvas) identica a pngjs ----------
{
  const tiles = [[10, 544, 373], [12, 2176, 1494], [8, 136, 93]];
  let same = true, info = [];
  for (const [z, x, y] of tiles) {
    const buf = Buffer.from(await (await fetch(TERRARIUM_URL(z, x, y))).arrayBuffer());
    const ref = PNG.sync.read(buf), mine = await decodePng(buf);
    const eq = ref.width === mine.width && ref.data.length === mine.data.length && ref.data.every((v, i) => v === mine.data[i]);
    same = same && eq; info.push(`${z}/${x}/${y}:${eq ? '=' : '≠'}`);
  }
  check('decodifica PNG JS identica bit per bit a pngjs', same, info.join(' '));
}

console.log(`\n${passes} superati, ${fails} falliti`);
process.exit(fails ? 1 : 0);
