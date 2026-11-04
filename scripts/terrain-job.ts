// Puts the ground's height in the bucket, from a one-shot Fly Machine (docs/terrain.md): zoom 10 of
// the open terrain tiles of AWS, byte for byte, in one PMTiles file. Their listing gives every
// tile's size and MD5, so the file is planned before a tile is read and written straight through,
// with no disk. Every tile is checked against its MD5, and at the end a sample is read back the way
// the page reads it and compared with the source.
//
//   AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3 AWS_REGION BUCKET_NAME
//   node scripts/terrain-job.ts                 the copy
//   TERRAIN_UPLOAD_ID                           a copy to take up again: its id is in the log
//   node scripts/terrain-job.ts --check <base>  only the read back, no keys needed

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PMTiles } from "pmtiles";
import { again, bucket, completeXml, eachLimited, partsDone, partsOf, type Bucket } from "./map-job.ts";
import { planArchive, storedBetween, type Plan, type TileIn } from "./pmtiles-write.ts";

export const TERRAIN_KEY = "terrain/terrarium-z10.pmtiles";
const ZOOM = 10;
const SOURCE = "https://s3.amazonaws.com/elevation-tiles-prod";
const tileUrl = (x: number, y: number) => `${SOURCE}/terrarium/${ZOOM}/${x}/${y}.png`;
const IMMUTABLE = "public, max-age=31536000, immutable";
const PMTILES_TYPE = "application/vnd.pmtiles";
const LISTINGS = 16;
/** Parts in flight, each up to 64 MB in memory, and tiles read at a time for each. */
const PARTS_AT_ONCE = 16;
const TILES_AT_ONCE = 16;
const CHECKS = 64;

export const METADATA = {
  name: "Terrain tiles, zoom 10 (terrarium)",
  source: "https://registry.opendata.aws/terrain-tiles/",
  attribution: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
};

/** One page of the bucket's listing: the tiles it names and where the next page starts. */
export function readListing(xml: string): { tiles: TileIn[]; next: string | null } {
  const tiles: TileIn[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>terrarium\/(\d+)\/(\d+)\/(\d+)\.png<\/Key>/.exec(m[1]);
    const length = Number(/<Size>(\d+)</.exec(m[1])?.[1]);
    const content = /<ETag>(?:&quot;|")?([0-9a-f]{32})(?:&quot;|")?<\/ETag>/.exec(m[1])?.[1];
    if (!key) continue;
    // Without an MD5 there would be nothing to check a tile against.
    if (!content || !length) throw new Error(`a tile with no MD5 or size: ${key[0]}`);
    tiles.push({ z: Number(key[1]), x: Number(key[2]), y: Number(key[3]), length, content });
  }
  const next = /<NextContinuationToken>([^<]+)</.exec(xml)?.[1];
  return { tiles, next: next ?? null };
}

async function listTiles(): Promise<TileIn[]> {
  const columns = Array.from({ length: 2 ** ZOOM }, (_, x) => x);
  const all: TileIn[][] = [];
  await eachLimited(columns, LISTINGS, async (x) => {
    let token: string | null = null;
    do {
      const query = `?list-type=2&prefix=${encodeURIComponent(`terrarium/${ZOOM}/${x}/`)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
      const page: { tiles: TileIn[]; next: string | null } = await again(`list ${x}`, async () => {
        const res = await fetch(SOURCE + query, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return readListing(await res.text());
      }, 8);
      all.push(page.tiles);
      token = page.next;
    } while (token);
  });
  return all.flat();
}

const md5Hex = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

/** One tile from the source, checked against the MD5 of its listing. */
async function readTile(tile: TileIn): Promise<Uint8Array> {
  return again(`tile ${tile.x}/${tile.y}`, async () => {
    const res = await fetch(tileUrl(tile.x, tile.y), { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (md5Hex(bytes) !== tile.content) throw new Error("not the bytes of its MD5");
    return bytes;
  }, 8);
}

/** Bytes [start, end] of the file: the head, then the tiles that fall there. */
export async function partBytes(plan: Plan, start: number, end: number, read: (tile: TileIn) => Promise<Uint8Array>, limit = TILES_AT_ONCE): Promise<Uint8Array> {
  const out = new Uint8Array(end - start + 1);
  const headLength = plan.head.length;
  if (start < headLength) out.set(plan.head.subarray(start, Math.min(headLength, end + 1)), 0);
  const stored = storedBetween(plan.stored, Math.max(0, start - headLength), end + 1 - headLength);
  await eachLimited(stored, limit, async ({ tile, offset }) => {
    const bytes = await read(tile);
    const at = headLength + offset;
    const from = Math.max(start, at);
    const to = Math.min(end + 1, at + bytes.length);
    out.set(bytes.subarray(from - at, to - at), from - start);
  });
  return out;
}

async function copy(store: Bucket, env: NodeJS.ProcessEnv): Promise<void> {
  const started = Date.now();
  const tiles = await listTiles();
  const plan = planArchive(tiles, METADATA);
  console.log(
    JSON.stringify({ addressed: plan.addressed, contents: plan.stored.length, entries: plan.entries, head: plan.head.length, tileData: plan.tileData, size: plan.size, listedInMinutes: Math.round((Date.now() - started) / 60_000) }),
  );

  const startUpload = async () => {
    const xml = await (await store.call("start upload", `/${TERRAIN_KEY}?uploads`, { method: "POST", headers: { "content-type": PMTILES_TYPE, "cache-control": IMMUTABLE } })).text();
    const id = /<UploadId>([^<]+)</.exec(xml)?.[1];
    if (!id) throw new Error("start upload: no id");
    return id;
  };
  const uploadId = env.TERRAIN_UPLOAD_ID || (await startUpload());
  const done = await partsDone(store, TERRAIN_KEY, uploadId);
  console.log(`upload id ${uploadId}, ${done.size} parts already there`);

  const parts = partsOf(plan.size).filter((p) => !done.has(p.number));
  const total = parts.length + done.size;
  let reported = 0;
  let written = 0;
  await eachLimited(parts, PARTS_AT_ONCE, async ({ number, start, end }) => {
    const bytes = await partBytes(plan, start, end, readTile);
    const md5 = createHash("md5").update(bytes).digest("base64");
    const put = await again(`write part ${number}`, () =>
      store.call(`write part ${number}`, `/${TERRAIN_KEY}?partNumber=${number}&uploadId=${encodeURIComponent(uploadId)}`, {
        method: "PUT",
        body: bytes as BodyInit,
        headers: { "content-md5": md5, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
        signal: AbortSignal.timeout(600_000),
      }),
    );
    await put.arrayBuffer();
    const tag = put.headers.get("etag");
    if (!tag) throw new Error(`write part ${number}: no ETag`);
    done.set(number, tag);
    written += bytes.length;
    const share = Math.floor((done.size / total) * 20);
    if (share > reported) {
      reported = share;
      console.log(`${share * 5} %: ${done.size} of ${total} parts, ${Math.round(written / ((Date.now() - started) / 1000) / 1e6)} MB/s`);
    }
  });

  const finish = await store.call("finish upload", `/${TERRAIN_KEY}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: "POST",
    body: completeXml([...done].map(([number, etag]) => ({ number, etag }))),
    headers: { "content-type": "application/xml" },
    signal: AbortSignal.timeout(1_800_000),
  });
  const answer = await finish.text();
  if (!answer.includes("CompleteMultipartUploadResult")) throw new Error(`finish upload: ${/<Code>([^<]+)</.exec(answer)?.[1] ?? "no result"}`);
  console.log(`copied in ${Math.round((Date.now() - started) / 60_000)} minutes`);

  const head = await store.call("HEAD copy", `/${TERRAIN_KEY}`, { method: "HEAD" });
  const copySize = Number(head.headers.get("content-length"));
  if (copySize !== plan.size) throw new Error(`the copy has ${copySize} bytes, the plan ${plan.size}`);
  console.log(`${copySize} bytes`);
}

/** Tiles read back the way the page reads them, by ranges from the public file, against the source. */
export async function check(base: string, count = CHECKS): Promise<void> {
  const file = new PMTiles(`${base.replace(/\/$/, "")}/${TERRAIN_KEY}`);
  const header = await file.getHeader();
  const picks = [[163, 395], [301, 387], [512, 340], [903, 403], ...Array.from({ length: count }, () => [Math.floor(Math.random() * 2 ** ZOOM), Math.floor(Math.random() * 2 ** ZOOM)])];
  let same = 0;
  let none = 0;
  await eachLimited(picks, 8, async ([x, y]) => {
    const source = await fetch(tileUrl(x, y));
    const copy = await file.getZxy(ZOOM, x, y);
    if (!source.ok) {
      if (copy) throw new Error(`${x}/${y}: the file has a tile the source does not`);
      none++;
      return;
    }
    const a = new Uint8Array(await source.arrayBuffer());
    const b = copy ? new Uint8Array(copy.data) : new Uint8Array();
    if (a.length !== b.length || md5Hex(a) !== md5Hex(b)) throw new Error(`${x}/${y}: not the same bytes`);
    same++;
  });
  console.log(`read back: ${same} tiles identical to the source, ${none} absent from both; ${header.numAddressedTiles} tiles, ${header.numTileContents} contents, ${header.numTileEntries} entries`);
}

async function main() {
  const asked = process.argv.indexOf("--check");
  if (asked > 0) return check(process.argv[asked + 1]);
  const { PUBLIC_BASE } = process.env;
  await copy(bucket(process.env), process.env);
  if (PUBLIC_BASE) await check(PUBLIC_BASE);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
