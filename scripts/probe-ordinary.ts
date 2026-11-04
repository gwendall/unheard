// Throwaway, never merged: how long the page takes on this machine, against production.
//   pnpm exec tsx scripts/probe-ordinary.ts
import { chromium, type Browser, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../lib/bundle";
import { STANDARD_AIR } from "../lib/core/doppler";
import { synthesize, type Source } from "../lib/core/synth";
import { buildTrack } from "../lib/core/track";
import { decodeTile, fixesOf, gunzip, mergeFlights } from "../lib/history";
import { fillIn, scene } from "../e2e/where-scene";

const BASE = process.env.BASE_URL ?? "https://unheard.gwendall.com";
const ONLY = process.env.ONLY?.split(",");
const JOB_S = Number(process.env.JOB_S ?? 1200);
setTimeout(() => { console.log("probe budget"); process.exit(1); }, Number(process.env.PROBE_S ?? 3300) * 1000).unref();
const dir = mkdtempSync(join(tmpdir(), "probe-"));
const TONES = [92, 118, 147, 171, 203];

async function sources(shift = 1): Promise<Source[]> {
  const day = new URL(`../e2e/history/${scene.day}/`, import.meta.url);
  const names = Object.keys((JSON.parse(readFileSync(new URL("manifest.json", day), "utf8")) as { tiles: object }).tiles);
  const tiles = await Promise.all(names.map(async (name) => decodeTile(await gunzip(new Uint8Array(readFileSync(new URL(`${name}.bin.gz`, day)))))));
  const flights = mergeFlights(tiles);
  const listener = { lat: scene.lat, lon: scene.lon, elevation: scene.elevation };
  return scene.aircraft.map((a, i) => {
    const track = buildTrack(fixesOf(flights.find((f) => f.hex === a.hex)!, scene.start - 120, scene.start + scene.duration + 120), listener);
    if (!track) throw new Error(a.hex);
    return { track, f0: TONES[i % TONES.length] * shift, level: 0.2 };
  });
}

/** The where page's test scene, its 5 minutes once or twice over (other tones the second time). */
async function sceneFile(name: string, rounds: number, rate: number): Promise<string> {
  const parts: Float32Array[] = [];
  for (let r = 0; r < rounds; r++) parts.push(synthesize({ start: scene.start, duration: scene.duration, sampleRate: rate, air: STANDARD_AIR, sources: await sources(r ? 1.37 : 1), noise: 0.5, rumble: 0.5, seed: 11 + r }));
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const path = join(dir, name);
  writeFileSync(path, encodeWav(all, rate));
  return path;
}

const clock = (t: string) => { const [days, rest] = t.includes("-") ? t.split("-") : ["0", t]; return Number(days) * 86400 + rest.split(":").reduce((a, x) => a * 60 + Number(x), 0); };
function tree() {
  const rows = execSync("ps -axo pid=,ppid=,rss=,time=,command=", { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[];
  const kids = new Map<number, RegExpMatchArray[]>();
  for (const r of rows) kids.set(Number(r[2]), [...(kids.get(Number(r[2])) ?? []), r]);
  let cpu = 0, rss = 0, renderer = 0;
  const walk = (pid: number) => { for (const r of kids.get(pid) ?? []) { cpu += clock(r[4]); rss += Number(r[3]); if (/--type=renderer/.test(r[5])) renderer = Math.max(renderer, Number(r[3])); walk(Number(r[1])); } };
  walk(process.pid);
  return { cpu, totalMB: Math.round(rss / 1024), rendererMB: Math.round(renderer / 1024) };
}

const STAGES: [RegExp, string][] = [[/Opening/, "open"], [/Listening/, "find"], [/Taking/, "clean"], [/Checking again/, "again"], [/Writing/, "write"], [/1 of 4/, "s1 tones"], [/2 of 4/, "s2 flights"], [/3 of 4/, "s3 search"], [/4 of 4/, "s4 refine"]];

/** Follows the page until `done` says so: when each stage shows, memory, CPU, workers. */
async function follow(page: Page, cdp: { send: (m: never) => Promise<{ targetInfos: { type: string }[] }> }, t0: number, done: () => Promise<boolean>, into: Record<string, unknown>) {
  const stages: Record<string, number> = {};
  const trail: string[] = [];
  let rendererMB = 0, totalMB = 0, workers = 0, last = 0, polls = 0;
  const started = tree().cpu;
  for (;;) {
    const now = (performance.now() - t0) / 1000;
    if (now > JOB_S) { into.timedOut = true; break; }
    const text = await page.evaluate(() => (document.querySelector('[data-testid="where-progress"]')?.textContent ?? "") + " " + (document.querySelector('[data-testid="check-progress"]')?.textContent ?? "")).catch(() => "");
    for (const [re, name] of STAGES) if (re.test(text) && stages[name] === undefined) stages[name] = +now.toFixed(1);
    if (now - last >= 15) { last = now; trail.push(`${Math.round(now)}s ${text.trim().slice(0, 60)}`); }
    if (polls++ % 4 === 0) {
      const t = tree();
      rendererMB = Math.max(rendererMB, t.rendererMB);
      totalMB = Math.max(totalMB, t.totalMB);
      workers = Math.max(workers, (await cdp.send("Target.getTargets" as never)).targetInfos.filter((x) => x.type === "worker").length);
    }
    if (await done()) break;
    await new Promise((go) => setTimeout(go, 250));
  }
  Object.assign(into, { stages, rendererMB, totalMB, workersAtMost: workers, cpu: tree().cpu - started, trail });
  return (performance.now() - t0) / 1000;
}

async function checkJob(browser: Browser, label: string, file: string) {
  const out: Record<string, unknown> = { job: label };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cdp = await browser.newBrowserCDPSession();
  try {
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 160)));
    await page.goto(new URL("/where", BASE).href, { waitUntil: "load" });
    const t0 = performance.now();
    await page.getByTestId("where-file").setInputFiles(file);
    const find: Record<string, unknown> = {};
    out.verdictAt = +(await follow(page, cdp as never, t0, () => page.getByTestId("check-verdict").isVisible(), find)).toFixed(1);
    out.find = find;
    out.verdict = await page.getByTestId("check-verdict").textContent();
    out.workersFind = await page.getByTestId("check").getAttribute("data-workers");
    const t1 = performance.now();
    await page.getByTestId("check-clean").click();
    const clean: Record<string, unknown> = {};
    out.cleanS = +(await follow(page, cdp as never, t1, () => page.getByTestId("check-download").isVisible(), clean)).toFixed(1);
    out.clean = clean;
    out.after = await page.getByTestId("check-verdict").textContent().catch(() => null);
    out.workersClean = await page.getByTestId("check").getAttribute("data-workers");
  } finally {
    await context.close();
  }
  console.log("RESULT " + JSON.stringify(out));
}

async function searchJob(browser: Browser, file: string) {
  const out: Record<string, unknown> = { job: "search, 5 min scene, known hour" };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cdp = await browser.newBrowserCDPSession();
  try {
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 160)));
    await page.goto(new URL("/where", BASE).href, { waitUntil: "load" });
    const t0 = performance.now();
    await page.getByTestId("where-file").setInputFiles(file);
    const find: Record<string, unknown> = {};
    out.verdictAt = +(await follow(page, cdp as never, t0, () => page.getByTestId("check-verdict").isVisible(), find)).toFixed(1);
    await page.getByTestId("where-find").click();
    await page.getByTestId("where-day").waitFor({ timeout: 60_000 });
    await fillIn(page);
    const t1 = performance.now();
    await page.getByTestId("where-search").click();
    const search: Record<string, unknown> = {};
    out.searchS = +(await follow(page, cdp as never, t1, () => page.getByTestId("where-verdict").isVisible(), search)).toFixed(1);
    out.search = search;
    out.answer = await page.getByTestId("where-verdict").textContent().catch(() => null);
    out.spot = await page.getByTestId("where-spot").textContent().catch(() => null);
    out.expected = { lat: scene.lat, lon: scene.lon, start: new Date(scene.start * 1000).toISOString() };
  } finally {
    await context.close();
  }
  console.log("RESULT " + JSON.stringify(out));
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  // One thread of plain arithmetic: how this machine's core compares.
  const coreMs = await page.evaluate(() => { const t = performance.now(); let s = 0; for (let i = 1; i < 3e8; i++) s += Math.sqrt(i) / i; return [performance.now() - t, s, navigator.hardwareConcurrency, (navigator as { deviceMemory?: number }).deviceMemory]; });
  await context.close();
  console.log("MACHINE " + JSON.stringify({ cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30), coreMs: Math.round(coreMs[0] as number), concurrency: coreMs[2], deviceMemory: coreMs[3] }));
  const want = (name: string) => !ONLY || ONLY.includes(name);
  if (want("5")) await checkJob(browser, "5 min, 16 kHz", await sceneFile("scene-5.wav", 1, 16_000));
  if (want("10")) await checkJob(browser, "10 min, 16 kHz", await sceneFile("scene-10.wav", 2, 16_000));
  if (want("48")) await checkJob(browser, "5 min, 48 kHz", await sceneFile("scene-48.wav", 1, 48_000));
  if (want("search")) await searchJob(browser, await sceneFile("scene-5b.wav", 1, 16_000));
} finally {
  await browser.close();
}
