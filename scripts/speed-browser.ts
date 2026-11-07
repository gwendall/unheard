// What a visitor waits for, in a real Chromium: time to the verdict on /check, the listening page's
// analysis (the example, which runs the same analyze() on the page's thread), and the first load
// of each route. Desktop and at a CPU throttled 4 times, as a phone stand-in. Point it at a
// production build (`next start`) or a deploy:
//
//   BASE_URL=http://localhost:4100 pnpm speed:browser [--runs 3] [--throttle 1,4] [--only load,listen,check] [--out file.json]
//
// The machine is shared: CPU time is what compares from one run to the next, never wall time. It
// comes from the browser's own process table (renderer processes, workers included), and the
// lowest of the runs counts. Peak memory: the JS heaps and array buffers of the page and its
// workers (CDP), and the renderer's resident size (ps).
//
// The CDP throttle slows the page's thread only, it does not reach dedicated workers (checked: an
// 85 s check takes 5.5 s at x1 and 5.6 s at x4). So what runs in a worker (the check, the where
// page) reads the same at both settings: its phone stand-in is the CPU time at x1 times 4, an
// estimate. The listening page's analysis runs on the page's thread and is throttled for real.
// CPU time compares only within one throttle setting.
//
// One browser, closed in `finally`; a context per run; each run has its own budget, from inside:
// 60 s, with larger multiples for the runs that take longer by design (85 s at x4: 2x; the 10
// minute file: 5x, 10x at x4; listening at x4: 4x).

import { execFileSync, execSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { STANDARD_AIR } from "../lib/core/doppler";
import { flybyFixes, synthesize } from "../lib/core/synth";
import { buildTrack } from "../lib/core/track";
import { encodeWav } from "../lib/bundle";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RUNS = Number(flag("runs") ?? 3);
const THROTTLES = (flag("throttle") ?? "1,4").split(",").map(Number);
const ONLY = (flag("only") ?? "load,listen,check").split(",");
const OUT = flag("out");

const FIXTURES = new URL("../e2e/fixtures/", import.meta.url);
const FLYBY = new URL("flyby.wav", FIXTURES);
const LONG = new URL("long-10min.wav", FIXTURES);

/** 60 s for one run, as every script that drives a browser here; a 10 minute file takes more. */
const BUDGET = 60_000;
function budget(ms: number, what: string) {
  const id = setTimeout(() => {
    console.error(`${what}: over its budget of ${ms / 1000} s`);
    process.exit(1); // Playwright's exit handlers close the browser.
  }, ms);
  id.unref();
  return () => clearTimeout(id);
}

/** Ten minutes at 48 kHz: three flybys in the noise, hum and rumble of the 85 s fixture. */
function makeLong() {
  if (existsSync(LONG)) return;
  mkdirSync(FIXTURES, { recursive: true });
  const T0 = 1_800_000_000;
  const RATE = 48_000;
  const listener = { lat: 48.8556, lon: 2.2986, elevation: 160 };
  const pass = (closestAt: number, offset: number, heading: number, speed: number, f0: number, level: number) => ({
    track: buildTrack(flybyFixes(listener, { closestAt: T0 + closestAt, offset, heading, speed, altitude: listener.elevation + 550, turnRate: 0.25 }, T0 + closestAt - 100, T0 + closestAt + 100, 0.5), listener)!,
    f0,
    level,
  });
  // A piece at a time, so the file never sits in memory whole.
  const seconds = 600;
  const piece = 60;
  const fd = openSync(LONG, "w");
  try {
    const bytes = seconds * RATE * 2;
    const header = encodeWav(new Float32Array(0), RATE).subarray(0, 44);
    const view = new DataView(header.buffer, header.byteOffset, 44);
    view.setUint32(4, 36 + bytes, true);
    view.setUint32(40, bytes, true);
    writeSync(fd, header);
    for (let at = 0; at < seconds; at += piece) {
      const samples = synthesize({
        start: T0 + at,
        duration: piece,
        sampleRate: RATE,
        air: STANDARD_AIR,
        sources: [pass(120, 420, 115, 56, 92, 0.15), pass(330, 900, 40, 70, 118, 0.25), pass(500, 350, 280, 55, 84, 0.12)],
        noise: 1,
        rumble: 1,
        hum: [{ freq: 50, level: 0.4 }],
        seed: 100 + at,
      });
      writeSync(fd, encodeWav(samples, RATE).subarray(44));
    }
  } finally {
    closeSync(fd);
  }
  console.log(`generated ${LONG.pathname}: ${Math.round(statSync(LONG).size / 1e6)} MB`);
}

type Sample = { heapMB: number; rssMB: number };

/** The browser's renderer processes: CPU seconds and process ids. */
async function renderers(browserSession: CDPSession) {
  const { processInfo } = (await browserSession.send("SystemInfo.getProcessInfo" as never)) as unknown as { processInfo: { type: string; id: number; cpuTime: number }[] };
  return processInfo.filter((p) => p.type === "renderer");
}

const cpuOf = (list: { cpuTime: number }[]) => list.reduce((sum, p) => sum + p.cpuTime, 0);

/** Resident megabytes of the largest of these processes. */
function residentMB(pids: number[]): number {
  if (!pids.length) return 0;
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
    return Math.max(0, ...out.trim().split(/\s+/).map((x) => Number(x) / 1024));
  } catch {
    return 0;
  }
}

type Heap = { usedSize: number; backingStorageSize?: number };
const heapMB = (h: Heap) => (h.usedSize + (h.backingStorageSize ?? 0)) / 2 ** 20;

/**
 * The page's dedicated workers, reached through the page's own CDP session (old-style, as Playwright
 * exposes no flattened child sessions): their heaps, read even while they compute.
 */
function watchWorkers(session: CDPSession) {
  const workers = new Set<string>();
  const pending = new Map<number, (heap: Heap) => void>();
  let next = 1;
  session.on("Target.attachedToTarget" as never, ((e: { sessionId: string; targetInfo: { type: string } }) => {
    if (e.targetInfo.type === "worker") workers.add(e.sessionId);
  }) as never);
  session.on("Target.detachedFromTarget" as never, ((e: { sessionId: string }) => workers.delete(e.sessionId)) as never);
  session.on("Target.receivedMessageFromTarget" as never, ((e: { message: string }) => {
    const m = JSON.parse(e.message) as { id?: number; result?: Heap };
    if (m.id && m.result) {
      pending.get(m.id)?.(m.result);
      pending.delete(m.id);
    }
  }) as never);
  return {
    start: () => session.send("Target.setAutoAttach" as never, { autoAttach: true, waitForDebuggerOnStart: false, flatten: false } as never),
    /** Each worker's heap and buffers, MB, within 500 ms or not at all. */
    heap: async () => {
      const each = [...workers].map(
        (sessionId) =>
          new Promise<number>((resolve) => {
            const id = next++;
            pending.set(id, (h) => resolve(heapMB(h)));
            setTimeout(() => resolve(0), 500);
            void session.send("Target.sendMessageToTarget" as never, { sessionId, message: JSON.stringify({ id, method: "Runtime.getHeapUsage" }) } as never).catch(() => resolve(0));
          }),
      );
      return (await Promise.all(each)).reduce((a, b) => a + b, 0);
    },
  };
}

/** Peaks of memory while `work` runs. */
async function sampling<T>(page: CDPSession, browserSession: CDPSession, workers: ReturnType<typeof watchWorkers>, work: () => Promise<T>): Promise<[T, Sample]> {
  const peak: Sample = { heapMB: 0, rssMB: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const [main, inWorkers, list] = await Promise.all([page.send("Runtime.getHeapUsage") as Promise<Heap>, workers.heap(), renderers(browserSession)]);
        peak.heapMB = Math.max(peak.heapMB, heapMB(main) + inWorkers);
        peak.rssMB = Math.max(peak.rssMB, residentMB(list.map((p) => p.id)));
      } catch {
        // The page went away: the run's own wait says so.
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  try {
    return [await work(), peak];
  } finally {
    running = false;
    await loop;
  }
}

type Setup = { context: BrowserContext; page: Page; session: CDPSession };

async function open(browser: Browser, throttle: number): Promise<Setup> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send("Performance.enable");
  if (throttle > 1) await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  return { context, page, session };
}

const lowest = (rows: Record<string, number>[], key: string) => Math.min(...rows.map((r) => r[key]));
const middle = (rows: Record<string, number>[], key: string) => rows.map((r) => r[key]).sort((a, b) => a - b)[rows.length >> 1];

type Row = { what: string; throttle: number; runs: number } & Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// The first load of a route: its JavaScript, its largest paint, the work on its main thread.

async function firstLoad(browser: Browser, path: string, throttle: number) {
  const done = budget(BUDGET, `load ${path}`);
  const { context, page, session } = await open(browser, throttle);
  try {
    const types = new Map<string, string>();
    let js = 0;
    let all = 0;
    await session.send("Network.enable");
    session.on("Network.responseReceived", (e) => types.set(e.requestId, e.type));
    session.on("Network.loadingFinished", (e) => {
      all += e.encodedDataLength;
      if (types.get(e.requestId) === "Script") js += e.encodedDataLength;
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __lcp: number };
      w.__lcp = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__lcp = Math.max(w.__lcp, entry.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });
    await page.goto(new URL(path, BASE).href, { waitUntil: "load" });
    // The largest paint settles once the page is interactive; never wait on the network going idle.
    await page.waitForTimeout(1500);
    const lcp = await page.evaluate(() => (window as unknown as { __lcp: number }).__lcp);
    const jsDecoded = await page.evaluate(() => performance.getEntriesByType("resource").reduce((sum, r) => (r.name.endsWith(".js") || (r as PerformanceResourceTiming).initiatorType === "script" ? sum + (r as PerformanceResourceTiming).decodedBodySize : sum), 0));
    const { metrics } = await session.send("Performance.getMetrics");
    const metric = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { jsKB: js / 1024, jsDecodedKB: jsDecoded / 1024, allKB: all / 1024, lcp: lcp / 1000, script: metric("ScriptDuration"), task: metric("TaskDuration") };
  } finally {
    await context.close();
    done();
  }
}

// ---------------------------------------------------------------------------------------------
// The listening page's analysis: the example card, which synthesizes its 90 s recording and runs
// analyze() on the page's thread, as a recording does when the microphone stops.

async function listen(browser: Browser, browserSession: CDPSession, throttle: number) {
  const done = budget(BUDGET * (throttle > 1 ? 4 : 1), "listen");
  const { context, page, session } = await open(browser, throttle);
  try {
    const workers = watchWorkers(session);
    await workers.start();
    await page.goto(new URL("/", BASE).href, { waitUntil: "load" });
    await page.getByTestId("example").waitFor();
    const before = cpuOf(await renderers(browserSession));
    const t0 = performance.now();
    const [, peak] = await sampling(session, browserSession, workers, async () => {
      await page.getByTestId("example").click();
      await page.getByTestId("verdict").waitFor({ timeout: BUDGET * 4 });
    });
    const wall = (performance.now() - t0) / 1000;
    const cpu = cpuOf(await renderers(browserSession)) - before;
    return { wall, cpu, heapMB: peak.heapMB, rssMB: peak.rssMB };
  } finally {
    await context.close();
    done();
  }
}

// ---------------------------------------------------------------------------------------------
// /check: a file picked, its sound decoded by Web Audio, the tones found in the worker, the verdict.

async function check(browser: Browser, browserSession: CDPSession, file: string, throttle: number, ms: number) {
  const done = budget(ms, `check ${file}`);
  const { context, page, session } = await open(browser, throttle);
  try {
    const workers = watchWorkers(session);
    await workers.start();
    await page.goto(new URL("/check", BASE).href, { waitUntil: "load" });
    await page.getByTestId("check-file").waitFor({ state: "attached" });
    const before = cpuOf(await renderers(browserSession));
    const t0 = performance.now();
    let decoded = 0;
    page.on("worker", () => (decoded ||= (performance.now() - t0) / 1000));
    const [, peak] = await sampling(session, browserSession, workers, async () => {
      await page.getByTestId("check-file").setInputFiles(file);
      await page.getByTestId("check-verdict").waitFor({ timeout: ms });
    });
    const wall = (performance.now() - t0) / 1000;
    const cpu = cpuOf(await renderers(browserSession)) - before;
    return { wall, decode: decoded, cpu, heapMB: peak.heapMB, rssMB: peak.rssMB };
  } finally {
    await context.close();
    done();
  }
}

// ---------------------------------------------------------------------------------------------

const results: Row[] = [];

async function repeat(what: string, throttle: number, run: () => Promise<Record<string, number>>, lowestKeys: string[]) {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await run();
    rows.push(r);
    console.log(`  ${what} x${throttle} run ${i + 1}: ${Object.entries(r).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}`);
  }
  const row: Row = { what, throttle, runs: RUNS };
  for (const key of Object.keys(rows[0])) row[key] = Number((lowestKeys.includes(key) ? lowest(rows, key) : middle(rows, key)).toFixed(2));
  results.push(row);
}

async function main() {
  if (ONLY.includes("check")) {
    if (!existsSync(FLYBY)) execSync("pnpm exec tsx scripts/make-e2e-fixture.ts", { stdio: "inherit" });
    makeLong();
  }
  const browser = await chromium.launch();
  try {
    const browserSession = await browser.newBrowserCDPSession();
    for (const throttle of THROTTLES) {
      if (ONLY.includes("load")) for (const path of ["/", "/check", "/where", "/somewhere-else"]) await repeat(`load ${path}`, throttle, () => firstLoad(browser, path, throttle), ["script", "task", "lcp"]);
      if (ONLY.includes("listen")) await repeat("listen", throttle, () => listen(browser, browserSession, throttle), ["cpu", "wall"]);
      if (ONLY.includes("check")) {
        await repeat("check 85 s", throttle, () => check(browser, browserSession, FLYBY.pathname, throttle, BUDGET * (throttle > 1 ? 2 : 1)), ["cpu", "wall", "decode"]);
        if (!args.includes("--short")) await repeat("check 10 min", throttle, () => check(browser, browserSession, LONG.pathname, throttle, BUDGET * (throttle > 1 ? 10 : 5)), ["cpu", "wall", "decode"]);
      }
    }
    console.table(results);
    if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
  } finally {
    await browser.close();
  }
}

await main();
