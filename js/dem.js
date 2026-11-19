// Modello digitale del terreno: AWS Terrain Tiles (formato Terrarium), globali, gratuite.
// quota = R*256 + G + B/256 − 32768 (m). Il mare (batimetria negativa) è riportato a 0 m.

import { tileCoord } from './geodesy.js';

export const TERRARIUM_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
// stesso archivio, nome host diverso (utile se un filtro DNS blocca uno dei due)
export const TERRARIUM_URL_ALT = (z, x, y) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;
let preferAlt = false;

// Decodifica PNG in JavaScript puro (senza canvas): i browser che proteggono dal fingerprinting
// (Firefox in modalità rigorosa, Brave, Tor) alterano i pixel letti da un canvas, e qui un'unità
// sul canale rosso vale 256 m di quota. Inflate nativo via DecompressionStream, poi de-filtraggio.
export async function decodePng(buf) {
  const u8 = new Uint8Array(buf);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => u8[i] === b)) throw new Error('non è un PNG');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos < u8.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(...u8.subarray(pos + 4, pos + 8));
    const data = u8.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (depth !== 8 || !channels || interlace) throw new Error(`PNG non supportato (bit ${depth}, tipo ${ctype}, interlacciato ${interlace})`);
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const bpp = channels, stride = width * bpp;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[up + x] : 0;
      const c = x >= bpp && y > 0 ? px[up + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + x] = v & 255;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += bpp) {
    const o = i * 4;
    if (channels >= 3) { rgba[o] = px[j]; rgba[o + 1] = px[j + 1]; rgba[o + 2] = px[j + 2]; }
    else rgba[o] = rgba[o + 1] = rgba[o + 2] = px[j];
    rgba[o + 3] = channels === 4 ? px[j + 3] : channels === 2 ? px[j + 1] : 255;
  }
  return { width, height, data: rgba };
}

// Decodifica di riserva tramite canvas (solo se manca DecompressionStream o la decodifica JS fallisce)
async function canvasDecode(buf) {
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: img.width, height: img.height, data: img.data };
}

// Loader per il browser: restituisce {width, height, data: Uint8ClampedArray RGBA}
export async function browserTileLoader(z, x, y) {
  let res;
  const urls = preferAlt ? [TERRARIUM_URL_ALT, TERRARIUM_URL] : [TERRARIUM_URL, TERRARIUM_URL_ALT];
  for (let i = 0; i < urls.length && !res; i++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try { res = await fetch(urls[i](z, x, y), { mode: 'cors', signal: ctl.signal }); if (i === 1) preferAlt = !preferAlt; }
    catch (e) { if (i === urls.length - 1) throw new Error(`rete (${e.name === 'AbortError' ? 'nessuna risposta in 20 s' : e.message || e}): s3.amazonaws.com non raggiungibile`); }
    finally { clearTimeout(timer); }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${z}/${x}/${y}`);
  const buf = await res.arrayBuffer();
  if (typeof DecompressionStream !== 'undefined') {
    try { return await decodePng(buf); }
    catch (e) { console.warn('decodifica PNG JS fallita, uso il canvas:', e); }
  }
  try { return await canvasDecode(buf); }
  catch (e) { throw new Error(`decodifica PNG (${e.message || e})`); }
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
      .catch((e) => { this.tiles.set(k, null); this.failures++; this.lastError = e?.message || String(e); return null; })
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
