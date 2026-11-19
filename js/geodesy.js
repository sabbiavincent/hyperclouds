// Geodesia sferica, curvatura del raggio (rifrazione terrestre k), coordinate tile Web Mercator.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const EARTH_R = 6371008.8;      // raggio medio IUGG (m)
export const DEFAULT_K = 0.13;         // coefficiente di rifrazione terrestre standard

export const effR = (k = DEFAULT_K) => EARTH_R / (1 - k);

export function destination(lat, lon, distM, azDeg) {
  if (distM <= 0) return { lat, lon };
  const dl = distM / EARTH_R, b = azDeg * D2R;
  const p1 = lat * D2R, l1 = lon * D2R;
  const sp2 = Math.sin(p1) * Math.cos(dl) + Math.cos(p1) * Math.sin(dl) * Math.cos(b);
  const p2 = Math.asin(Math.max(-1, Math.min(1, sp2)));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(dl) * Math.cos(p1), Math.cos(dl) - Math.sin(p1) * sp2);
  return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
}

/**
 * Quota s.l.m. (m) del raggio che parte dall'osservatore (quota h0) con elevazione apparente elDeg,
 * alla distanza d (m), su sfera di raggio efficace R_eff (curvatura del raggio inclusa).
 */
export function rayAltitude(d, h0, elDeg, k = DEFAULT_K) {
  if (d <= 0) return h0;
  const R = effR(k), psi = d / R, e = elDeg * D2R;
  const den = Math.cos(e + psi);
  if (den <= 1e-9) return Infinity;
  return (R + h0) * Math.cos(e) / den - R;
}

/** Angolo apparente (gradi) sotto cui si vede un punto di quota h a distanza d da quota h0. */
export function elevationAngle(d, h0, h, k = DEFAULT_K) {
  if (d <= 0) return -90;
  const R = effR(k), psi = d / R;
  return Math.atan2((R + h) * Math.cos(psi) - (R + h0), (R + h) * Math.sin(psi)) * R2D;
}

/** Distanza (m) a cui un raggio orizzontale da quota h0 raggiunge la quota h (orizzonte di uno strato). */
export function horizonDistanceToLayer(h0, h, k = DEFAULT_K) {
  const R = effR(k);
  return Math.sqrt(2 * R * Math.max(0, h0)) + Math.sqrt(2 * R * Math.max(0, h));
}

export function tileCoord(lat, lon, z) {
  const n = 2 ** z;
  const la = Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R;
  const xf = ((lon + 180) / 360) * n;
  const yf = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n;
  const x = Math.min(n - 1, Math.max(0, Math.floor(xf)));
  const y = Math.min(n - 1, Math.max(0, Math.floor(yf)));
  return { z, x, y, px: (xf - x) * 256, py: (yf - y) * 256 };
}
