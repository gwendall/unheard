// The ground's height, for where-and-when: how high an aircraft flew above a listener depends on
// the ground under the listener. Read from the open terrain tiles of AWS (terrarium encoding,
// zoom 10: pixels of about 120 m at 37°; SRTM, GMTED, NED and other public sources,
// https://registry.opendata.aws/terrain-tiles/). No DOM, no Node: the caller supplies a fetcher.

/** A terrarium tile's PNG bytes, or null when there is none. */
export type TileFetcher = (z: number, x: number, y: number) => Promise<Uint8Array | null>;

export const ZOOM = 10;

export const terrainUrl = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** Tiles over HTTP. */
export const httpTiles: TileFetcher = async (z, x, y) => {
  const res = await fetch(terrainUrl(z, x, y));
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
};

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One terrarium tile (256 x 256, RGB or RGBA PNG): height = R * 256 + G + B / 256 - 32768 m. */
export async function decodeTerrarium(png: Uint8Array): Promise<Float32Array> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat: Uint8Array[] = [];
  let width = 0;
  let channels = 3;
  for (let o = 8; o < png.length; ) {
    const n = view.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (type === "IHDR") {
      width = view.getUint32(o + 8);
      channels = png[o + 17] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + n));
    o += 12 + n;
  }
  const joined = new Uint8Array(idat.reduce((s, c) => s + c.length, 0));
  idat.reduce((at, c) => (joined.set(c, at), at + c.length), 0);
  const raw = await inflate(joined);
  const stride = width * channels;
  const out = new Uint8Array(width * stride);
  // Undo the PNG row filters (none, sub, up, average, Paeth).
  for (let y = 0; y < width; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? out[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  const h = new Float32Array(width * width);
  for (let i = 0; i < width * width; i++) h[i] = out[i * channels] * 256 + out[i * channels + 1] + out[i * channels + 2] / 256 - 32768;
  return h;
}

/**
 * The ground's height above sea level over a square `side` metres wide around a point (and 15 km
 * more), read back bilinearly; 0 where no tile is found or below the sea.
 */
export async function groundOf(tiles: TileFetcher, lat: number, lon: number, side: number): Promise<(lat: number, lon: number) => number> {
  const n = 2 ** ZOOM;
  const xOf = (lo: number) => ((lo + 180) / 360) * n;
  const yOf = (la: number) => ((1 - Math.log(Math.tan((la * Math.PI) / 180) + 1 / Math.cos((la * Math.PI) / 180)) / Math.PI) / 2) * n;
  const half = side / 2 + 15_000;
  const dLat = half / 111_195;
  const dLon = half / (111_195 * Math.cos((lat * Math.PI) / 180));
  const heights = new Map<string, Float32Array>();
  for (let x = Math.floor(xOf(lon - dLon)); x <= Math.floor(xOf(lon + dLon)); x++) {
    for (let y = Math.floor(yOf(lat + dLat)); y <= Math.floor(yOf(lat - dLat)); y++) {
      const png = await tiles(ZOOM, x, y);
      if (png) heights.set(`${x}/${y}`, await decodeTerrarium(png));
    }
  }
  const at = (px: number, py: number) => {
    const x = Math.floor(px / 256);
    const y = Math.floor(py / 256);
    const t = heights.get(`${x}/${y}`);
    return t ? Math.max(0, t[(py - y * 256) * 256 + (px - x * 256)]) : 0;
  };
  return (la: number, lo: number) => {
    const px = xOf(lo) * 256 - 0.5;
    const py = yOf(la) * 256 - 0.5;
    const x = Math.floor(px);
    const y = Math.floor(py);
    const fx = px - x;
    const fy = py - y;
    return (1 - fy) * ((1 - fx) * at(x, y) + fx * at(x + 1, y)) + fy * ((1 - fx) * at(x, y + 1) + fx * at(x + 1, y + 1));
  };
}
