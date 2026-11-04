// A few workers for work that splits into pieces: a long recording's stretches, groups of tones.
// Each piece depends only on what it is given and answers come back with the piece that asked, so
// the result is the one the pieces would give one after the other (lib/core holds the loops).

import { shapeOf, stretchOf, type Shape, type Stretch, type StretchRunner } from "../core/flyby";
import { findChunk, inline, takeOutOf, type ChunkFound, type Pieces } from "../core/leak";
import { scanPart, type ScanPart } from "../core/tracks";
import type { WherePieces } from "../core/wherewhen";
import type { PieceInput, PieceOutput } from "./piece.worker";

/** What is used of a Worker: a test brings its own. */
export type PoolWorker = {
  postMessage: (message: unknown, transfer: Transferable[]) => void;
  terminate: () => void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
};

/** What a piece's worker answers: how far it has got, then its result or what went wrong. */
export type PieceReply<Out> = { id: number; share: number } | { id: number; out: Out } | { id: number; error: string };

/** What a worker of the pool is asked. */
export type Piece<In> = { id: number; input: In };

export type Pool<In, Out> = {
  /** How many pieces at a time. */
  size: number;
  run: (input: In, transfer?: Transferable[], onShare?: (share: number) => void) => Promise<Out>;
  /** The workers stop, and what they hold goes with them. */
  close: () => void;
};

/** Workers by cores alone: one core stays with the page and the browser. */
export function poolSize(cores: number): number {
  return Math.max(1, Math.min(6, Math.floor(cores) - 1));
}

/** A device, as far as a worker can tell. `phone` comes from the page (lib/client/device.ts): a worker has no matchMedia. */
export type Device = { cores: number; memoryGb?: number; phone?: boolean };

/** What a job has to hold: what it is, how long the sound is, and for taking out, the file's own rate. */
export type Job = { kind: "find" | "clean" | "search"; seconds: number; rate?: number };

/** MB the page may reach on a device that a full tab can kill without warning: iOS Safari does around 1 to 2 GB. */
export const PHONE_BUDGET_MB = 700;
const BUDGET_MB_PER_GB = PHONE_BUDGET_MB / 4;

// The renderer's peak on the page, in Chromium, production build, with no workers and with six:
//   real clip, 1 min, 22 kHz: 328, and 46 a worker | 1 min, 48 kHz, two channels: 452, and 129 a worker
//   10 min, 48 kHz: 516, and 117 a worker | a real hour, finding its tones, 8 kHz: 413, and 82 a worker
//   a real hour, searched, over New York: 1479, and 48 a worker | its first 10 min: 989
// A worker on a job that may look again holds a chunk's stack, whatever the file's rate.
const FIND_WORKER_MB = 82;
const SEARCH_WORKER_MB = 48;

/** The peak a job should reach, with these workers. */
export function estimatedMB({ kind, seconds, rate = 48_000 }: Job, workers: number): number {
  const minutes = seconds / 60;
  const kHz = rate / 1000;
  if (kind === "find") return 300 + 1.9 * minutes + workers * FIND_WORKER_MB;
  if (kind === "clean") return 220 + 4.8 * kHz + 7 * minutes + workers * Math.max(FIND_WORKER_MB, 2.7 * kHz);
  return 890 + 10 * minutes + workers * SEARCH_WORKER_MB;
}

/** The MB this device can give a job, or none to count: a computer has room for all its workers. */
export function budgetMB({ memoryGb, phone }: Device): number {
  if (memoryGb !== undefined && memoryGb <= 4) return Math.min(PHONE_BUDGET_MB, memoryGb * BUDGET_MB_PER_GB);
  return phone ? PHONE_BUDGET_MB : Infinity;
}

/**
 * Workers for this job on this device: as many as the cores take and the budget leaves room for.
 * None where one would not pay for itself, or the job alone fills the budget: slower, never out of
 * memory. The answer is the same with any number of them.
 */
export function workersFor(device: Device, job: Job): number {
  const cores = poolSize(device.cores);
  const budget = budgetMB(device);
  let workers = cores;
  while (workers > 0 && estimatedMB(job, workers) > budget) workers--;
  return workers > 1 ? workers : 0;
}

/**
 * A worker silent this long is taken for lost, and its piece fails: a job must never wait on what
 * will not answer. Too soon only costs doing the piece again here, with the same result; a piece
 * tells how far it has got many times a second, and a worker loading under load takes seconds.
 */
export const SILENT_MS = 60_000;

/** Workers made as pieces arrive, never more than `size`, stopped by `close`. */
export function poolOf<In, Out>(make: () => PoolWorker, size: number): Pool<In, Out> {
  type Waiting = { input: In; transfer: Transferable[]; onShare?: (share: number) => void; resolve: (out: Out) => void; reject: (err: Error) => void };
  const idle: PoolWorker[] = [];
  const queue: Waiting[] = [];
  const running = new Map<number, Waiting>();
  const workers: PoolWorker[] = [];
  let nextId = 0;
  let lost = 0;
  let closed = false;

  const pump = () => {
    while (queue.length && !closed) {
      let worker = idle.pop();
      if (!worker && workers.length + lost < size) worker = start();
      if (!worker) {
        // Every worker is gone: nothing would ever run these.
        if (!workers.length) for (const job of queue.splice(0)) job.reject(new Error("no workers"));
        return;
      }
      const job = queue.shift()!;
      const id = nextId++;
      running.set(id, job);
      owner.set(worker, id);
      watch(worker);
      worker.postMessage({ id, input: job.input } satisfies Piece<In>, job.transfer);
    }
  };

  const owner = new Map<PoolWorker, number>();
  const watches = new Map<PoolWorker, ReturnType<typeof setTimeout>>();
  const unwatch = (worker: PoolWorker) => {
    clearTimeout(watches.get(worker));
    watches.delete(worker);
  };
  const watch = (worker: PoolWorker) => {
    unwatch(worker);
    watches.set(worker, setTimeout(() => lose(worker, new Error("silent")), SILENT_MS));
  };
  /** A worker gone: it never gets another piece, the one it held fails, and the pool goes on with one less. */
  const lose = (worker: PoolWorker, why: Error) => {
    unwatch(worker);
    const id = owner.get(worker);
    const job = id === undefined ? undefined : running.get(id);
    if (id !== undefined) running.delete(id);
    owner.delete(worker);
    workers.splice(workers.indexOf(worker), 1);
    if (idle.includes(worker)) idle.splice(idle.indexOf(worker), 1);
    lost++;
    worker.terminate();
    job?.reject(why);
    pump();
  };
  const start = (): PoolWorker | undefined => {
    let worker: PoolWorker;
    try {
      worker = make();
    } catch {
      lost++;
      return undefined;
    }
    workers.push(worker);
    worker.onmessage = (e: MessageEvent<PieceReply<Out>>) => {
      const reply = e.data;
      const job = running.get(reply.id);
      if (!job) return;
      if ("share" in reply) {
        watch(worker);
        job.onShare?.(reply.share);
        return;
      }
      unwatch(worker);
      running.delete(reply.id);
      owner.delete(worker);
      if ("error" in reply) job.reject(new Error(reply.error));
      else job.resolve(reply.out);
      idle.push(worker);
      pump();
    };
    // Heard here, so it goes no further: unheard, it would reach the page as this job's own failure.
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      lose(worker, new Error(e.message || "worker"));
    };
    return worker;
  };

  return {
    size,
    run: (input, transfer = [], onShare) =>
      new Promise<Out>((resolve, reject) => {
        if (closed) return reject(new Error("closed"));
        queue.push({ input, transfer, onShare, resolve, reject });
        pump();
      }),
    close: () => {
      closed = true;
      for (const worker of watches.keys()) clearTimeout(watches.get(worker));
      watches.clear();
      for (const worker of workers) worker.terminate();
      workers.length = 0;
      idle.length = 0;
      for (const job of [...queue, ...running.values()]) job.reject(new Error("closed"));
      queue.length = 0;
      running.clear();
    },
  };
}

/**
 * A long recording's stretches over the workers of a pool. A worker that cannot start or dies (no
 * room, a browser without nested workers) costs its piece some time, not the job: it is done here.
 */
export function stretchesOf(pool: Pool<PieceInput, PieceOutput>): StretchRunner {
  return {
    size: pool.size,
    // A view is copied with its whole buffer: a stretch goes alone, not with the hour around it.
    stretch: (samples, rate, onShare) => (pool.run({ do: "stretch", samples: samples.slice(), rate }, [], onShare) as Promise<Stretch>).catch(() => stretchOf(samples, rate, onShare)),
  };
}

/** The search's separable work over the workers of a pool. */
export function wherePiecesOf(pool: Pool<PieceInput, PieceOutput>): WherePieces {
  return {
    size: pool.size,
    shape: (t, y, c) => (pool.run({ do: "shape", t, y, c }) as Promise<Shape>).catch(() => shapeOf(t, y, c)),
    part: (tones, paths, jets, options, longest, onShare) =>
      (pool.run({ do: "scan", tones, paths, jets, options, longest }, [], onShare) as Promise<ScanPart>).catch(() => scanPart(tones, paths, jets, { ...options, onProgress: (done, total) => onShare(done / total) }, longest)),
  };
}

/**
 * The check's separable work over the workers of a pool. What goes is copied, not handed over: a
 * worker that dies leaves it here to do again.
 */
export function checkPiecesOf(pool: Pool<PieceInput, PieceOutput>): Pieces {
  return {
    size: pool.size,
    chunk: (samples, start, rate, options, onShare) => (pool.run({ do: "chunk", samples, start, rate, options }, [], onShare) as Promise<ChunkFound>).catch(() => findChunk(samples, start, rate, options, onShare)),
    takeOut: (job, onShare) => (pool.run({ do: "takeOut", job }, [], onShare) as Promise<Float32Array[]>).catch(() => takeOutOf(job, onShare)),
  };
}

/** A pool for this job on this device, or none where the work had better stay here. */
export function poolForDevice(job: Job, phone?: boolean, make: () => PoolWorker = pieceWorker): Pool<PieceInput, PieceOutput> | null {
  if (typeof Worker === "undefined") return null;
  const size = workersFor({ cores: navigator.hardwareConcurrency || 2, memoryGb: (navigator as { deviceMemory?: number }).deviceMemory, phone }, job);
  return size ? poolOf<PieceInput, PieceOutput>(make, size) : null;
}

/** One worker of the pool. */
const pieceWorker = () => new Worker(new URL("./piece.worker.ts", import.meta.url)) as unknown as PoolWorker;

/** A job over this device's pool, gone with the job so the memory it holds goes too. Without one, `work` gets null. */
export async function withPool<T>(job: Job, phone: boolean | undefined, work: (pool: Pool<PieceInput, PieceOutput> | null) => Promise<T>): Promise<T> {
  const pool = poolForDevice(job, phone);
  try {
    return await work(pool);
  } finally {
    pool?.close();
  }
}

/** A check's job over this device's pool, gone with the job. Without one, the pieces run here. */
export const withPieces = <T>(job: Job, phone: boolean | undefined, work: (pieces: Pieces) => Promise<T>): Promise<T> => withPool(job, phone, (pool) => work(pool ? checkPiecesOf(pool) : inline));
