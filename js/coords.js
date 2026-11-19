// Coordinate: decimali ("43.7696, 11.2558") o gradi-primi-secondi ("43°46'10.6\"N 11°15'20.9\"E")
export function parseCoords(txt) {
  const t = txt.trim().replace(/[′’]/g, "'").replace(/[″”]/g, '"');
  const dms = [...t.matchAll(/(\d+(?:[.,]\d+)?)\s*°\s*(?:(\d+(?:[.,]\d+)?)\s*'\s*)?(?:(\d+(?:[.,]\d+)?)\s*"\s*)?([NSEWO])/gi)];
  if (dms.length === 2) {
    const v = dms.map((m) => {
      const x = (+m[1].replace(',', '.')) + (+(m[2] || 0).toString().replace(',', '.')) / 60 + (+(m[3] || 0).toString().replace(',', '.')) / 3600;
      return { x: /[SWO]/i.test(m[4]) ? -x : x, ax: /[NS]/i.test(m[4]) ? 'lat' : 'lon' };
    });
    const lat = v.find((a) => a.ax === 'lat'), lon = v.find((a) => a.ax === 'lon');
    if (lat && lon) return { lat: lat.x, lon: lon.x };
  }
  const m = t.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lat: +m[1], lon: +m[2] };
  return null;
}
