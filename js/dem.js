// Modello digitale del terreno: AWS Terrain Tiles (formato Terrarium), globali, gratuite.
// quota = R*256 + G + B/256 − 32768 (m). Il mare (batimetria negativa) è riportato a 0 m.

import { tileCoord } from './geodesy.js';

export const TERRARIUM_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// Loader per il browser: restituisce {width, height, data: Uint8ClampedArray RGBA}
export async function browserTileLoader(z, x, y) {
  const res = await fetch(TERRARIUM_URL(z, x, y), { mode: 'cors' });
  if (!res.ok) throw new Error(`DEM ${z}/${x}/${y}: HTTP ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: img.width, height: img.height, data: img.data };
}

export class Dem {
  constructor(loader, { concurrency = 8 } = {}) {
    this.loader = loader;
    this.tiles = new Map();      // key -> tile | null (fallita)
    this.pending = new Map();    // key -> Promise
    this.concurrency = concurrency;
    this.failures = 0;
  }

  static key(z, x, y) { return `${z}/${x}/${y}`; }

  _load(z, x, y) {
    const k = Dem.key(z, x, y);
    if (this.tiles.has(k)) return Promise.resolve(this.tiles.get(k));
    if (this.pending.has(k)) return this.pending.get(k);
    const p = this.loader(z, x, y)
      .then((t) => { this.tiles.set(k, t); return t; })
      .catch(() => { this.tiles.set(k, null); this.failures++; return null; })
      .finally(() => this.pending.delete(k));
    this.pending.set(k, p);
    return p;
  }

  /** Scarica (in parallelo limitato) tutte le tile necessarie per i punti [{lat,lon,z}]. */
  async prefetch(points, onProgress) {
    const keys = new Map();
    for (const p of points) {
      const c = tileCoord(p.lat, p.lon, p.z);
      keys.set(Dem.key(c.z, c.x, c.y), c);
    }
    const todo = [...keys.values()].filter((c) => !this.tiles.has(Dem.key(c.z, c.x, c.y)));
    let done = 0;
    const queue = todo.slice();
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift();
        await this._load(c.z, c.x, c.y);
        done++;
        onProgress?.(done, todo.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, todo.length) }, worker));
    return { requested: todo.length };
  }

  /** Quota per interpolazione bilineare; richiede tile già caricata (null se mancante). */
  sample(lat, lon, z) {
    const c = tileCoord(lat, lon, z);
    const t = this.tiles.get(Dem.key(c.z, c.x, c.y));
    if (!t) return null;
    const w = t.width, max = w - 1;
    const px = c.px - 0.5, py = c.py - 0.5;   // centri dei pixel
    const x0 = Math.max(0, Math.min(max, Math.floor(px))), y0 = Math.max(0, Math.min(max, Math.floor(py)));
    const x1 = Math.min(max, x0 + 1), y1 = Math.min(max, y0 + 1);
    const dx = Math.max(0, Math.min(1, px - x0)), dy = Math.max(0, Math.min(1, py - y0));
    const h = (x, y) => {
      const i = (y * w + x) * 4, d = t.data;
      return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
    };
    const v = (h(x0, y0) * (1 - dx) + h(x1, y0) * dx) * (1 - dy) + (h(x0, y1) * (1 - dx) + h(x1, y1) * dx) * dy;
    return Math.max(0, v);
  }

  async elevation(lat, lon, z = 13) {
    await this.prefetch([{ lat, lon, z }]);
    return this.sample(lat, lon, z);
  }
}
