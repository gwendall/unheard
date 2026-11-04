// A few workers for work that splits into pieces: a long recording's stretches, groups of tones.
// Each piece depends only on what it is given and answers come back with the piece that asked, so
// the result is the one the pieces would give one after the other (lib/core holds the loops).

import { shapeOf, stretchOf, type Shape, type Stretch, type StretchRunner } from "../core/flyby";
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

/**
 * Workers for this device: one core stays with the page and the browser. A phone with little
 * memory gets two: a chunk's stack runs to 200 MB.
 */
export function poolSize(cores: number, memoryGb?: number): number {
  const most = memoryGb !== undefined && memoryGb <= 4 ? 2 : 6;
  return Math.max(1, Math.min(most, Math.floor(cores) - 1));
}

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
      worker.postMessage({ id, input: job.input } satisfies Piece<In>, job.transfer);
    }
  };

  const owner = new Map<PoolWorker, number>();
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
        job.onShare?.(reply.share);
        return;
      }
      running.delete(reply.id);
      owner.delete(worker);
      if ("error" in reply) job.reject(new Error(reply.error));
      else job.resolve(reply.out);
      idle.push(worker);
      pump();
    };
    // A worker that dies takes its piece with it: that piece fails, and the pool goes on with one less.
    worker.onerror = (e: ErrorEvent) => {
      const id = owner.get(worker);
      const job = id === undefined ? undefined : running.get(id);
      if (id !== undefined) running.delete(id);
      owner.delete(worker);
      workers.splice(workers.indexOf(worker), 1);
      lost++;
      worker.terminate();
      job?.reject(new Error(e.message || "worker"));
      pump();
    };
    return worker;
  };

  return {
    size,
    run: (input, transfer = [], onShare) =>
      new Promise<Out>((resolve, reject) => {
        queue.push({ input, transfer, onShare, resolve, reject });
        pump();
      }),
    close: () => {
      closed = true;
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

/** A pool for this device, or none where the work had better stay here. */
export function poolForDevice(make: () => PoolWorker = pieceWorker): Pool<PieceInput, PieceOutput> | null {
  if (typeof Worker === "undefined") return null;
  const size = poolSize(navigator.hardwareConcurrency || 2, (navigator as { deviceMemory?: number }).deviceMemory);
  return size > 1 ? poolOf<PieceInput, PieceOutput>(make, size) : null;
}

/** One worker of the pool. */
const pieceWorker = () => new Worker(new URL("./piece.worker.ts", import.meta.url)) as unknown as PoolWorker;

/** A job over this device's pool, gone with the job so the memory it holds goes too. Without one, `job` gets null. */
export async function withPool<T>(job: (pool: Pool<PieceInput, PieceOutput> | null) => Promise<T>): Promise<T> {
  const pool = poolForDevice();
  try {
    return await job(pool);
  } finally {
    pool?.close();
  }
}
