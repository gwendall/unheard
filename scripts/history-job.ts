// Puts the flight history online: builds yesterday's day if adsb.lol has published it, then older
// missing days going backwards, within a time budget, and uploads each one tiles first, manifest
// last, so that a day whose manifest is in the bucket is complete. Safe to run again at any time.
// A scheduled Fly Machine runs it and stops when it exits ("Hosting" in docs/history-format.md);
// any S3 bucket will do.
//
//   AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3 AWS_REGION BUCKET_NAME
//   HISTORY_JOB_BUDGET_MINUTES  no new day starts past this (default 20)
//   HISTORY_JOB_MAX_DAYS        no new day starts past this many built (default no limit): a day
//                               uploaded has a price, whatever the speed of the machine that day
//   HISTORY_JOB_FIRST           days to build before the others (2026-09-08,2026-05-16)
//   HISTORY_JOB_OLDEST          where going backwards stops (default 2026-01-01)
//   HISTORY_JOB_SHARD           i/n, this machine's part of the list when several run at once
//   HISTORY_JOB_WORKERS         the builder's workers (default 3: on a shared CPU more only waits)

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";
import type { Manifest } from "../lib/history.ts";

const DAY = 86_400_000;
const OLDEST = "2026-01-01";
/** A built day never changes. Only the list of days does. */
export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SHORT = "public, max-age=300";
const JSON_TYPE = "application/json; charset=utf-8";
const UPLOADS = 16;
const CORS = `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><MaxAgeSeconds>86400</MaxAgeSeconds></CORSRule></CORSConfiguration>`;

/** The bucket, as little as the job needs of it. */
export type Store = {
  has(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array, type: string, cache: string): Promise<void>;
  /** The folders at the top of the bucket. */
  folders(): Promise<string[]>;
  /** GET and HEAD from any origin, set once. */
  allowAnyOrigin(): Promise<void>;
};

/** Which days to try, in order: the ones asked first, then from yesterday back to `oldest`. */
export function daysToBuild(now: Date, { first = [], oldest = OLDEST, shard = [0, 1] }: { first?: string[]; oldest?: string; shard?: [number, number] } = {}): string[] {
  const days = new Set(first);
  const yesterday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY;
  for (let t = yesterday; t >= Date.parse(oldest); t -= DAY) days.add(new Date(t).toISOString().slice(0, 10));
  return [...days].filter((_, i) => i % shard[1] === shard[0]);
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

/** Uploads a built day from `<dir>/<day>/`. The manifest goes last: a failure leaves none. */
export async function publishDay(store: Store, dir: string, day: string): Promise<void> {
  const file = (name: string) => readFileSync(join(dir, day, name));
  const manifest = file("manifest.json");
  const { tiles } = JSON.parse(manifest.toString("utf8")) as Manifest;
  await eachLimited(Object.keys(tiles), UPLOADS, (name) => store.put(`${day}/${name}.bin.gz`, file(`${name}.bin.gz`), "application/gzip", IMMUTABLE));
  await store.put(`${day}/build.json`, file("build.json"), JSON_TYPE, IMMUTABLE);
  await store.put(`${day}/manifest.json`, manifest, JSON_TYPE, IMMUTABLE);
}

/** Rewrites days.json from what is in the bucket: a day counts once its manifest is there. */
export async function refreshDays(store: Store): Promise<string[]> {
  const folders = (await store.folders()).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f));
  const days: string[] = [];
  await eachLimited(folders, UPLOADS, async (day) => {
    if (await store.has(`${day}/manifest.json`)) days.push(day);
  });
  days.sort();
  const body = { format: "unheard-history/v1", licence: "ODbL-1.0", attribution: "© adsb.lol contributors", days };
  await store.put("days.json", new TextEncoder().encode(JSON.stringify(body, null, 1) + "\n"), JSON_TYPE, SHORT);
  return days;
}

/** An S3 bucket by path (the error's <Code> is all that is kept: the rest can quote the key id). */
export function s3Store(env: NodeJS.ProcessEnv): Store {
  const names = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION", "BUCKET_NAME"];
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`missing from the environment: ${missing.join(", ")}`);
  const aws = new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY!, region: env.AWS_REGION!, service: "s3", retries: 4 });
  const base = `${env.AWS_ENDPOINT_URL_S3!.replace(/\/$/, "")}/${env.BUCKET_NAME!}`;
  const call = async (what: string, url: string, init: RequestInit, ok: (status: number) => boolean = (s) => s < 300) => {
    // aws4fetch retries 5xx and 429; this covers a connection that drops.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await aws.fetch(url, init);
        if (ok(res.status)) return res;
        const code = /<Code>([^<]+)<\/Code>/.exec(await res.text())?.[1] ?? "";
        throw new Error(`${what}: HTTP ${res.status} ${code}`);
      } catch (e) {
        if (attempt >= 2 || (e as Error).message.startsWith(`${what}:`)) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  };
  return {
    async has(key) {
      const res = await call(`HEAD ${key}`, `${base}/${key}`, { method: "HEAD" }, (s) => s < 300 || s === 404);
      return res.status !== 404;
    },
    async put(key, body, type, cache) {
      const res = await call(`PUT ${key}`, `${base}/${key}`, { method: "PUT", body: body as BodyInit, headers: { "content-type": type, "cache-control": cache } });
      await res.arrayBuffer();
    },
    async folders() {
      const folders: string[] = [];
      let token = "";
      for (;;) {
        const query = `?list-type=2&delimiter=%2F${token && `&continuation-token=${encodeURIComponent(token)}`}`;
        const xml = await (await call("LIST", `${base}/${query}`, {})).text();
        for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)\/<\/Prefix><\/CommonPrefixes>/g)) folders.push(m[1]);
        token = /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? "";
        if (!token) return folders;
      }
    },
    async allowAnyOrigin() {
      const res = await call("GET cors", `${base}?cors`, {}, (s) => s < 300 || s === 404);
      const now = await res.text();
      if (res.ok && ["<AllowedOrigin>*<", "<AllowedMethod>GET<", "<AllowedMethod>HEAD<"].every((part) => now.includes(part))) return;
      const md5 = createHash("md5").update(CORS).digest("base64");
      const put = await call("PUT cors", `${base}?cors`, { method: "PUT", body: CORS, headers: { "content-type": "application/xml", "content-md5": md5 } });
      await put.arrayBuffer();
      console.log("CORS set: GET and HEAD from any origin");
    },
  };
}

/** adsb.lol's day is out? The plain page, not the API: a cloud machine shares its address, and the API's 60 requests an hour with it. */
async function releaseIsOut(day: string): Promise<boolean> {
  const [y, m, d] = day.split("-");
  const res = await fetch(`https://github.com/adsblol/globe_history_${y}/releases/tag/v${y}.${m}.${d}-planes-readsb-prod-0`, { method: "HEAD", headers: { "user-agent": "unheard-history/1" }, signal: AbortSignal.timeout(30_000) });
  return res.ok;
}

/** The builder, in its own process: its memory is gone when the day is, and a crash is one failed day. */
function buildDay(day: string, out: string, workers: string): Promise<void> {
  const builder = fileURLToPath(new URL("./history-index.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builder, day, "--out", out, "--workers", workers, "--force"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`builder exited with ${signal ?? code}`))));
  });
}

async function main() {
  const env = process.env;
  const started = Date.now();
  const budget = Number(env.HISTORY_JOB_BUDGET_MINUTES ?? 20) * 60_000;
  const maxDays = Number(env.HISTORY_JOB_MAX_DAYS ?? Infinity);
  const shard = (env.HISTORY_JOB_SHARD ?? "0/1").split("/").map(Number) as [number, number];
  const first = (env.HISTORY_JOB_FIRST ?? "").split(",").filter(Boolean);
  const days = daysToBuild(new Date(), { first, oldest: env.HISTORY_JOB_OLDEST, shard });
  const store = s3Store(env);
  const out = join(tmpdir(), "unheard-history");
  mkdirSync(out, { recursive: true });

  await store.allowAnyOrigin();
  const tally = { built: [] as string[], already: 0, noRelease: [] as string[], failed: [] as string[], left: 0 };
  for (const [i, day] of days.entries()) {
    if (Date.now() - started >= budget || tally.built.length >= maxDays) {
      tally.left = days.length - i;
      break;
    }
    try {
      if (await store.has(`${day}/manifest.json`)) {
        tally.already++;
        continue;
      }
      if (!(await releaseIsOut(day))) {
        tally.noRelease.push(day);
        continue;
      }
      const t0 = Date.now();
      await buildDay(day, out, env.HISTORY_JOB_WORKERS ?? "3");
      const t1 = Date.now();
      await publishDay(store, out, day);
      await refreshDays(store);
      tally.built.push(day);
      console.log(`${day}: built in ${Math.round((t1 - t0) / 1000)} s, uploaded in ${Math.round((Date.now() - t1) / 1000)} s`);
    } catch (e) {
      tally.failed.push(day);
      console.error(`${day}: failed, no manifest: ${(e as Error).message}`);
    } finally {
      rmSync(join(out, day), { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ ...tally, minutes: Math.round((Date.now() - started) / 6000) / 10 }));
  if (tally.failed.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
