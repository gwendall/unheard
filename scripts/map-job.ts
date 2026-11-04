// Puts the map in the bucket, from a one-shot Fly Machine (docs/map.md): Protomaps' daily build of
// OpenStreetMap as it is, one PMTiles file, copied by ranged GETs into a multipart upload with no
// disk; the fonts and the sprite the labels need, so that the page asks nothing of anyone else; and
// the CORS rule that lets a browser read ranges. Safe to run again.
//
//   AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3 AWS_REGION BUCKET_NAME
//   node scripts/map-job.ts --cors                the CORS rule
//   node scripts/map-job.ts --planet 20261103     the map of that day
//   node scripts/map-job.ts --assets              fonts and sprite
//   MAP_UPLOAD_ID                                 a copy to take up again: its id is in the log

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";

const BUILDS = "https://build.protomaps.com";
/** A build's size and hash, to check the copy against. */
const BUILD_LIST = "https://build-metadata.protomaps.dev/builds.json";
const IMMUTABLE = "public, max-age=31536000, immutable";
const PMTILES_TYPE = "application/vnd.pmtiles";
/** 139 GB in 2,100 parts, of the 10,000 S3 allows. Parts in flight are held in memory. */
export const PART = 64 * 1024 * 1024;
const COPIES = 24;
/** Ranges compared between the build and the copy once it is done. */
const CHECKS = 32;
const CHECK_BYTES = 256 * 1024;

/** Fonts and sprite: a pinned commit of protomaps/basemaps-assets, copied once. */
const ASSETS_COMMIT = "028c18f713baecad011301ff7a69acc39bcc2ae7";
const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic", "Noto Sans Devanagari Regular v1"];
const SPRITE = ["dark.json", "dark.png", "dark@2x.json", "dark@2x.png"];
const CONTENT_TYPES: Record<string, string> = { json: "application/json", png: "image/png", pbf: "application/x-protobuf" };

/**
 * Any origin may read, as before, and may now also read a range: PMTiles reads the ETag to notice
 * a file that changed under it, and Content-Range on a short file.
 */
export const CORS = `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>Content-Range</ExposeHeader><ExposeHeader>Content-Length</ExposeHeader><ExposeHeader>Accept-Ranges</ExposeHeader><MaxAgeSeconds>86400</MaxAgeSeconds></CORSRule></CORSConfiguration>`;

/** Whether a bucket's CORS already allows all of it. */
export function corsReady(xml: string): boolean {
  return ["<AllowedOrigin>*<", "<AllowedMethod>GET<", "<AllowedMethod>HEAD<", "<ExposeHeader>ETag<", "<ExposeHeader>Content-Range<"].every((part) => xml.includes(part));
}

/** The parts of a file: 1-based numbers and inclusive ranges, as S3 and HTTP count them. */
export function partsOf(size: number, part = PART): { number: number; start: number; end: number }[] {
  const parts = [];
  for (let start = 0, number = 1; start < size; start += part, number++) parts.push({ number, start, end: Math.min(size, start + part) - 1 });
  return parts;
}

export function completeXml(parts: { number: number; etag: string }[]): string {
  const sorted = [...parts].sort((a, b) => a.number - b.number);
  return `<CompleteMultipartUpload>${sorted.map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
}

/** Runs `task` on each item, a few at a time; the first failure stops the rest. */
async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        try {
          await task(items[next++]);
        } catch (e) {
          next = items.length;
          throw e;
        }
      }
    }),
  );
}

async function again<T>(what: string, task: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (e) {
      if (attempt >= attempts) throw new Error(`${what}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

/** The bucket by path, as in history-job.ts: of an error only its <Code>, the rest can quote the key id. */
function bucket(env: NodeJS.ProcessEnv) {
  const names = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION", "BUCKET_NAME"];
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`missing from the environment: ${missing.join(", ")}`);
  const aws = new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!, region: env.AWS_REGION!, service: "s3", retries: 4 });
  const base = `${env.AWS_ENDPOINT_URL_S3!.replace(/\/$/, "")}/${env.BUCKET_NAME!}`;
  const call = async (what: string, path: string, init: RequestInit, ok: (status: number) => boolean = (s) => s < 300) => {
    const res = await aws.fetch(`${base}${path}`, init);
    if (ok(res.status)) return res;
    const code = /<Code>([^<]+)<\/Code>/.exec(await res.text())?.[1] ?? "";
    throw new Error(`${what}: HTTP ${res.status} ${code}`);
  };
  return { call, url: (key: string) => `${base}/${key}` };
}

type Bucket = ReturnType<typeof bucket>;

async function setCors(store: Bucket): Promise<void> {
  const res = await store.call("GET cors", "?cors", {}, (s) => s < 300 || s === 404);
  if (res.ok && corsReady(await res.text())) return console.log("CORS already allows ranges");
  const md5 = createHash("md5").update(CORS).digest("base64");
  await (await store.call("PUT cors", "?cors", { method: "PUT", body: CORS, headers: { "content-type": "application/xml", "content-md5": md5 } })).arrayBuffer();
  console.log("CORS set: GET and HEAD from any origin, with ranges readable");
}

/** The parts of an upload already in the bucket, to take a copy up again. */
async function partsDone(store: Bucket, key: string, uploadId: string): Promise<Map<number, string>> {
  const done = new Map<number, string>();
  let marker = "";
  for (;;) {
    const xml = await (await store.call("LIST parts", `/${key}?uploadId=${encodeURIComponent(uploadId)}&max-parts=1000${marker && `&part-number-marker=${marker}`}`, {})).text();
    for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const number = Number(/<PartNumber>(\d+)</.exec(m[1])?.[1]);
      const etag = /<ETag>([^<]+)</.exec(m[1])?.[1].replaceAll("&#34;", '"').replaceAll("&quot;", '"');
      if (number && etag) done.set(number, etag);
    }
    marker = /<NextPartNumberMarker>(\d+)</.exec(xml)?.[1] ?? "";
    if (!/<IsTruncated>true</.test(xml) || !marker) return done;
  }
}

async function copyPlanet(store: Bucket, build: string, key: string, env: NodeJS.ProcessEnv): Promise<void> {
  const source = `${BUILDS}/${build}.pmtiles`;
  const list = (await (await fetch(BUILD_LIST)).json()) as { key: string; size: number; b3sum: string; version: string }[];
  const entry = list.find((b) => b.key === `${build}.pmtiles`);
  if (!entry) throw new Error(`${build} is not in the list of builds`);
  const head = await fetch(source, { method: "HEAD" });
  const etag = head.headers.get("etag");
  const size = Number(head.headers.get("content-length"));
  if (!etag || size !== entry.size) throw new Error(`${source}: ${size} bytes, the list says ${entry.size}`);
  console.log(JSON.stringify({ source, size, b3sum: entry.b3sum, version: entry.version }));

  let uploadId = env.MAP_UPLOAD_ID ?? "";
  const done = uploadId ? await partsDone(store, key, uploadId) : new Map<number, string>();
  if (!uploadId) {
    const xml = await (await store.call("start upload", `/${key}?uploads`, { method: "POST", headers: { "content-type": PMTILES_TYPE, "cache-control": IMMUTABLE } })).text();
    uploadId = /<UploadId>([^<]+)</.exec(xml)?.[1] ?? "";
    if (!uploadId) throw new Error("start upload: no id");
  }
  console.log(`upload id ${uploadId}, ${done.size} parts already there`);

  const parts = partsOf(size);
  const started = Date.now();
  let copied = 0;
  let reported = 0;
  await eachLimited(parts.filter((p) => !done.has(p.number)), COPIES, async ({ number, start, end }) => {
    const bytes = await again(`read part ${number}`, async () => {
      const res = await fetch(source, { headers: { range: `bytes=${start}-${end}`, "if-match": etag }, signal: AbortSignal.timeout(600_000) });
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.length !== end - start + 1) throw new Error(`${body.length} bytes`);
      return body;
    });
    const md5 = createHash("md5").update(bytes).digest("base64");
    const put = await again(`write part ${number}`, () =>
      store.call(`write part ${number}`, `/${key}?partNumber=${number}&uploadId=${encodeURIComponent(uploadId)}`, {
        method: "PUT",
        body: bytes as BodyInit,
        // TLS and the MD5 guard the bytes; hashing 64 MB again in JavaScript would add nothing.
        headers: { "content-md5": md5, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
        signal: AbortSignal.timeout(600_000),
      }),
    );
    await put.arrayBuffer();
    const tag = put.headers.get("etag");
    if (!tag) throw new Error(`write part ${number}: no ETag`);
    done.set(number, tag);
    copied += bytes.length;
    const share = Math.floor((done.size / parts.length) * 20);
    if (share > reported) {
      reported = share;
      console.log(`${share * 5} %: ${done.size} of ${parts.length} parts, ${Math.round(copied / ((Date.now() - started) / 1000) / 1e6)} MB/s`);
    }
  });

  const finish = await store.call("finish upload", `/${key}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: "POST",
    body: completeXml([...done].map(([number, etag]) => ({ number, etag }))),
    headers: { "content-type": "application/xml" },
    signal: AbortSignal.timeout(1_800_000),
  });
  const answer = await finish.text();
  if (!answer.includes("CompleteMultipartUploadResult")) throw new Error(`finish upload: ${/<Code>([^<]+)</.exec(answer)?.[1] ?? "no result"}`);
  console.log(`copied in ${Math.round((Date.now() - started) / 60_000)} minutes`);
  await checkCopy(store, source, key, size);
}

/** The copy against the build: the size, the start (header and root directory), the end, and ranges at random. */
async function checkCopy(store: Bucket, source: string, key: string, size: number): Promise<void> {
  const head = await store.call("HEAD copy", `/${key}`, { method: "HEAD" });
  const copySize = Number(head.headers.get("content-length"));
  if (copySize !== size) throw new Error(`the copy has ${copySize} bytes, the build ${size}`);
  const starts = [0, size - CHECK_BYTES, ...Array.from({ length: CHECKS }, () => Math.floor(Math.random() * (size - CHECK_BYTES)))];
  const sha = (b: ArrayBuffer) => createHash("sha256").update(new Uint8Array(b)).digest("hex");
  await eachLimited(starts, 8, async (start) => {
    const range = `bytes=${start}-${start + CHECK_BYTES - 1}`;
    const a = sha(await (await fetch(source, { headers: { range } })).arrayBuffer());
    const b = sha(await (await store.call("read copy", `/${key}`, { headers: { range } })).arrayBuffer());
    if (a !== b) throw new Error(`the copy differs from the build at ${start}`);
  });
  console.log(`the copy matches the build: ${size} bytes, ${starts.length} ranges compared`);
}

async function copyAssets(store: Bucket): Promise<void> {
  const raw = `https://raw.githubusercontent.com/protomaps/basemaps-assets/${ASSETS_COMMIT}`;
  const files: { url: string; key: string }[] = SPRITE.map((file) => ({ url: `${raw}/sprites/v4/${file}`, key: `map/sprites/v4/${file}` }));
  for (const font of FONTS) {
    for (let start = 0; start < 65536; start += 256) {
      const file = `${start}-${start + 255}.pbf`;
      files.push({ url: `${raw}/fonts/${encodeURIComponent(font)}/${file}`, key: `map/fonts/${encodeURIComponent(font)}/${file}` });
    }
  }
  let copied = 0;
  let bytes = 0;
  await eachLimited(files, 8, async ({ url, key }) => {
    const res = await again(url, async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      return r;
    });
    if (!res.ok) return;
    const body = new Uint8Array(await res.arrayBuffer());
    await (await again(`PUT ${key}`, () => store.call(`PUT ${key}`, `/${key}`, { method: "PUT", body: body as BodyInit, headers: { "content-type": CONTENT_TYPES[key.split(".").pop()!], "cache-control": IMMUTABLE } }))).arrayBuffer();
    copied++;
    bytes += body.length;
  });
  console.log(`${copied} files, ${Math.round(bytes / 1e6)} MB`);
}

async function main() {
  const store = bucket(process.env);
  const planet = process.argv.indexOf("--planet");
  if (process.argv.includes("--cors")) await setCors(store);
  if (process.argv.includes("--assets")) await copyAssets(store);
  if (planet > 0) await copyPlanet(store, process.argv[planet + 1], `map/protomaps-${process.argv[planet + 1]}.pmtiles`, process.env);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
