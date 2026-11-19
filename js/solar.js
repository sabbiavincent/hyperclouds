// Effemeridi solari (algoritmo NOAA / Meeus), rifrazione standard, finestre crepuscolari.
// Tutti i tempi sono millisecondi UTC (epoch). Angoli in gradi. Azimut: 0 = Nord, orario.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const norm360 = (x) => ((x % 360) + 360) % 360;

// Semidiametro apparente medio del disco solare (gradi)
export const SUN_SEMIDIAMETER = 0.2666;

export function refractionDeg(elGeo) {
  if (elGeo > 85) return 0;
  const t = Math.tan(elGeo * D2R);
  let arcsec;
  if (elGeo > 5) arcsec = 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5;
  else if (elGeo > -0.575)
    arcsec = 1735 + elGeo * (-518.2 + elGeo * (103.4 + elGeo * (-12.79 + elGeo * 0.711)));
  else arcsec = -20.774 / t;
  return arcsec / 3600;
}

export function sunPosition(ms, latDeg, lonDeg) {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = norm360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const Mr = M * D2R;
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * D2R);
  const sec = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
  const eps0 = 23 + (26 + sec / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega * D2R)) * D2R;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda * D2R));
  const y = Math.tan(eps / 2) ** 2;
  const L0r = L0 * D2R;
  const eqTime =
    4 * R2D *
    (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
  const minutesUTC = (((ms % 86400000) + 86400000) % 86400000) / 60000;
  const tst = (((minutesUTC + eqTime + 4 * lonDeg) % 1440) + 1440) % 1440;
  const ha = (tst / 4 - 180) * D2R;
  const lat = latDeg * D2R;
  const cosZ = Math.min(1, Math.max(-1,
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha)));
  const elGeo = 90 - Math.acos(cosZ) * R2D;
  // Azimut con atan2 (robusto anche ai poli)
  const az = norm360(
    Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) * R2D + 180);
  const refr = refractionDeg(elGeo);
  return { t: ms, az, elGeo, refr, el: elGeo + refr };
}

// Elevazione del bordo superiore del disco (apparente)
const upperLimb = (p) => p.el + SUN_SEMIDIAMETER;

/**
 * Cerca gli istanti in [t0, t1] in cui f(t) = sunPosition(t).el (centro, apparente) attraversa `threshold`.
 * Ritorna [{t, rising}]. Passo grossolano + bisezione.
 */
export function findCrossings(t0, t1, lat, lon, threshold, { limb = false, stepMin = 2 } = {}) {
  const f = (t) => {
    const p = sunPosition(t, lat, lon);
    return (limb ? upperLimb(p) : p.el) - threshold;
  };
  const out = [];
  const step = stepMin * 60000;
  let ta = t0, fa = f(ta);
  for (let tb = t0 + step; tb <= t1 + 1; tb += step) {
    const fb = f(tb);
    if ((fa <= 0 && fb > 0) || (fa >= 0 && fb < 0)) {
      let lo = ta, hi = tb, flo = fa;
      for (let i = 0; i < 30 && hi - lo > 500; i++) {
        const mid = (lo + hi) / 2, fm = f(mid);
        if ((flo <= 0) === (fm <= 0)) { lo = mid; flo = fm; } else hi = mid;
      }
      out.push({ t: Math.round((lo + hi) / 2), rising: fb > fa });
    }
    ta = tb; fa = fb;
  }
  return out;
}

/**
 * Finestra attorno ad alba o tramonto del giorno locale [dayStart, dayStart+24h).
 * L'evento è il bordo superiore del disco sull'orizzonte astronomico (definizione ufficiale).
 * La finestra va da elevazione `upper` a `lower` (es. +6° .. −6°), adattandosi a latitudine e stagione.
 */
export function eventWindow(dayStartMs, lat, lon, type, upper = 6, lower = -6) {
  const day = 86400000;
  const rising = type === 'sunrise';
  const events = findCrossings(dayStartMs, dayStartMs + day, lat, lon, 0, { limb: true, stepMin: 2 })
    .filter((c) => c.rising === rising);
  if (!events.length) {
    const noon = sunPosition(dayStartMs + day / 2, lat, lon);
    return { ok: false, reason: noon.el > 0 ? 'Il Sole non tramonta in questa data (sole di mezzanotte)'
                                              : 'Il Sole non sorge in questa data (notte polare)' };
  }
  const tEv = events[0].t;
  const span = 8 * 3600000;
  // bordo "alto" (Sole più alto) e bordo "basso" (Sole più basso) della finestra
  const highCross = findCrossings(tEv - span, tEv + span, lat, lon, upper)
    .filter((c) => c.rising === rising);
  const lowCross = findCrossings(tEv - span, tEv + span, lat, lon, lower)
    .filter((c) => c.rising === rising);
  const nearest = (arr, before) => {
    const c = arr.filter((x) => (before ? x.t <= tEv : x.t >= tEv));
    if (!c.length) return null;
    return before ? c[c.length - 1].t : c[0].t;
  };
  let notes = [];
  // tramonto: alto prima, basso dopo; alba: basso prima, alto dopo
  let tHigh = nearest(highCross, !rising);
  let tLow = nearest(lowCross, rising);
  if (tHigh == null) {
    tHigh = extremumTime(tEv, lat, lon, !rising, true);
    notes.push(`il Sole non sale a +${upper}°`);
  }
  if (tLow == null) {
    tLow = extremumTime(tEv, lat, lon, rising, false);
    notes.push(`il Sole non scende a ${lower}°`);
  }
  const start = Math.min(tHigh, tLow), end = Math.max(tHigh, tLow);
  return { ok: true, event: tEv, start, end, notes };
}

// Istante di massimo/minimo di elevazione entro 12 h prima/dopo tEv
function extremumTime(tEv, lat, lon, before, findMax) {
  let best = tEv, bestEl = sunPosition(tEv, lat, lon).el;
  for (let k = 1; k <= 720; k++) {
    const t = tEv + (before ? -1 : 1) * k * 60000;
    const el = sunPosition(t, lat, lon).el;
    if (findMax ? el > bestEl : el < bestEl) { best = t; bestEl = el; }
  }
  return best;
}

// ---- Fusi orari (IANA) senza librerie ----

export function tzOffsetMs(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

// Mezzanotte locale (inizio del giorno `yyyy-mm-dd`) nel fuso `tz`, come ms UTC
export function zonedDayStart(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return t;
}

export function formatLocal(ms, tz, withSeconds = false) {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
  }).format(new Date(ms));
}
