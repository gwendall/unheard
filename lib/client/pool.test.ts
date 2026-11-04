import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetMB, checkPiecesOf, estimatedMB, PHONE_BUDGET_MB, poolOf, poolSize, SILENT_MS, workersFor, type Piece, type PieceReply, type PoolWorker } from "./pool";
import type { PieceInput, PieceOutput } from "./piece.worker";

/** Workers the test answers by hand, in the order it likes. */
function workers() {
  const made: (PoolWorker & { asked: Piece<number>[]; stopped: boolean })[] = [];
  const make = () => {
    const worker = {
      asked: [] as Piece<number>[],
      stopped: false,
      onmessage: null as PoolWorker["onmessage"],
      onerror: null as PoolWorker["onerror"],
      postMessage(message: unknown) {
        this.asked.push(message as Piece<number>);
      },
      terminate() {
        this.stopped = true;
      },
    };
    made.push(worker);
    return worker;
  };
  const answer = (i: number, reply: PieceReply<number>) => made[i].onmessage?.({ data: reply } as MessageEvent);
  return { made, make, answer };
}

/** What a dying worker sends. */
const death = (message: string, heard = () => {}) => ({ message, preventDefault: heard }) as unknown as ErrorEvent;

describe("poolSize", () => {
  it("leaves a core to the page, and has a ceiling", () => {
    expect(poolSize(1)).toBe(1);
    expect(poolSize(2)).toBe(1);
    expect(poolSize(4)).toBe(3);
    expect(poolSize(18)).toBe(6);
  });
});

describe("workersFor", () => {
  const phone = { cores: 6, phone: true };
  const find = (minutes: number) => ({ kind: "find" as const, seconds: minutes * 60 });
  const clean = (minutes: number, rate: number) => ({ kind: "clean" as const, seconds: minutes * 60, rate });
  const search = (minutes: number) => ({ kind: "search" as const, seconds: minutes * 60 });

  it("gives a computer what its cores take, however long the file", () => {
    for (const job of [find(600), clean(600, 48_000), search(600)]) expect(workersFor({ cores: 18, memoryGb: 8 }, job)).toBe(6);
    expect(workersFor({ cores: 18 }, find(600))).toBe(6);
    expect(workersFor({ cores: 2 }, find(1))).toBe(0);
  });

  it("gives a phone fewer as the file grows, and none in the end", () => {
    expect(workersFor(phone, find(1))).toBe(4);
    expect(workersFor(phone, find(60))).toBe(3);
    expect(workersFor(phone, find(180))).toBe(0);
    expect(workersFor(phone, clean(1, 8000))).toBe(5);
    expect(workersFor(phone, clean(1, 22_050))).toBe(4);
    expect(workersFor(phone, clean(1, 44_100))).toBe(2);
    expect(workersFor(phone, clean(1, 48_000))).toBe(0);
    expect(workersFor(phone, clean(60, 8000))).toBe(0);
  });

  it("never goes past a phone's budget with its workers", () => {
    for (const minutes of [0.5, 1, 5, 10, 30, 60, 120, 240, 600])
      for (const job of [find(minutes), clean(minutes, 8000), clean(minutes, 22_050), clean(minutes, 48_000), search(minutes)]) {
        const workers = workersFor(phone, job);
        if (workers) expect(estimatedMB(job, workers)).toBeLessThanOrEqual(PHONE_BUDGET_MB);
      }
  });

  it("searches on a phone with no worker: the search alone is past the budget", () => {
    expect(workersFor(phone, search(1))).toBe(0);
    expect(estimatedMB(search(1), 0)).toBeGreaterThan(PHONE_BUDGET_MB);
  });

  it("holds any device with 4 GB or less to a budget, tighter with less", () => {
    expect(budgetMB({ cores: 8, memoryGb: 4 })).toBe(PHONE_BUDGET_MB);
    expect(budgetMB({ cores: 8, memoryGb: 2 })).toBe(PHONE_BUDGET_MB / 2);
    expect(budgetMB({ cores: 8, memoryGb: 8 })).toBe(Infinity);
    expect(workersFor({ cores: 8, memoryGb: 4 }, find(10))).toBe(4);
    expect(workersFor({ cores: 8, memoryGb: 2 }, find(10))).toBe(0);
    // A phone with room still goes by a phone's budget: its tab can be closed all the same.
    expect(workersFor({ cores: 8, memoryGb: 8, phone: true }, find(10))).toBe(4);
  });
});

describe("poolOf", () => {
  it("makes workers only as needed and holds to its size", async () => {
    const { made, make, answer } = workers();
    const pool = poolOf<number, number>(make, 2);
    expect(made.length).toBe(0);
    const pieces = [pool.run(10), pool.run(20), pool.run(30)];
    expect(made.length).toBe(2);
    expect(made[0].asked.map((p) => p.input)).toEqual([10]);
    expect(made[1].asked.map((p) => p.input)).toEqual([20]);
    // The second answers first; each answer goes to the piece that asked, the third starts.
    answer(1, { id: made[1].asked[0].id, out: 21 });
    expect(await pieces[1]).toBe(21);
    expect(made[1].asked.map((p) => p.input)).toEqual([20, 30]);
    answer(1, { id: made[1].asked[1].id, out: 31 });
    answer(0, { id: made[0].asked[0].id, out: 11 });
    expect(await Promise.all(pieces)).toEqual([11, 21, 31]);
    pool.close();
    expect(made.every((w) => w.stopped)).toBe(true);
  });

  it("passes on how far a piece has got", async () => {
    const { made, make, answer } = workers();
    const pool = poolOf<number, number>(make, 1);
    const shares: number[] = [];
    const piece = pool.run(1, [], (s) => shares.push(s));
    const { id } = made[0].asked[0];
    answer(0, { id, share: 0.5 });
    answer(0, { id, out: 2 });
    expect(await piece).toBe(2);
    expect(shares).toEqual([0.5]);
    pool.close();
  });

  it("fails the piece a worker could not do", async () => {
    const { made, make, answer } = workers();
    const pool = poolOf<number, number>(make, 1);
    const piece = pool.run(1);
    answer(0, { id: made[0].asked[0].id, error: "no" });
    await expect(piece).rejects.toThrow("no");
    pool.close();
  });

  it("fails the piece of a worker that dies", async () => {
    const { made, make } = workers();
    const pool = poolOf<number, number>(make, 1);
    const piece = pool.run(1);
    let heard = false;
    made[0].onerror?.(death("out of memory", () => void (heard = true)));
    await expect(piece).rejects.toThrow("out of memory");
    // Unheard, it would reach the page as the job's own failure.
    expect(heard).toBe(true);
    pool.close();
  });

  it("goes on with the workers left, and fails at once what none can run", async () => {
    const { made, make, answer } = workers();
    const pool = poolOf<number, number>(make, 2);
    const pieces = [pool.run(1), pool.run(2), pool.run(3)];
    made[0].onerror?.(death("gone"));
    await expect(pieces[0]).rejects.toThrow("gone");
    // The other worker takes what was waiting; none is made in place of the lost one.
    answer(1, { id: made[1].asked[0].id, out: 20 });
    expect(await pieces[1]).toBe(20);
    expect(made[1].asked.map((p) => p.input)).toEqual([2, 3]);
    expect(made.length).toBe(2);
    made[1].onerror?.(death("gone too"));
    await expect(pieces[2]).rejects.toThrow("gone too");
    await expect(pool.run(4)).rejects.toThrow("no workers");
    pool.close();
  });

  it("fails at once when no worker can start", async () => {
    const pool = poolOf<number, number>(() => {
      throw new Error("no nested workers");
    }, 2);
    await expect(pool.run(1)).rejects.toThrow("no workers");
    pool.close();
  });

  it("fails what is still waiting when it closes", async () => {
    const { make } = workers();
    const pool = poolOf<number, number>(make, 1);
    const pieces = [pool.run(1), pool.run(2)];
    pool.close();
    await expect(pieces[0]).rejects.toThrow("closed");
    await expect(pieces[1]).rejects.toThrow("closed");
  });
});

describe("a pool never leaves a job waiting", () => {
  afterEach(() => void vi.useRealTimers());

  it("never hands a piece to a worker that died while it had nothing to do", async () => {
    const { made, make, answer } = workers();
    const pool = poolOf<number, number>(make, 2);
    const first = pool.run(1);
    answer(0, { id: made[0].asked[0].id, out: 1 });
    await first;
    made[0].onerror?.(death("gone"));
    const next = pool.run(2);
    // Not to the dead one: a new one, which answers.
    expect(made[0].asked.length).toBe(1);
    expect(made[1].asked.length).toBe(1);
    answer(1, { id: made[1].asked[0].id, out: 2 });
    await expect(next).resolves.toBe(2);
    pool.close();
  });

  it("gives up on a worker that says nothing, and goes on with the others", async () => {
    vi.useFakeTimers();
    const { made, make, answer } = workers();
    const pool = poolOf<number, number>(make, 2);
    const silent = pool.run(1);
    const failed = expect(silent).rejects.toThrow("silent");
    const talking = pool.run(2);
    vi.advanceTimersByTime(SILENT_MS / 2);
    answer(1, { id: made[1].asked[0].id, share: 0.5 });
    vi.advanceTimersByTime(SILENT_MS / 2 + 1);
    await failed;
    expect(made[0].stopped).toBe(true);
    // Hearing from it put its own limit off.
    expect(made[1].stopped).toBe(false);
    answer(1, { id: made[1].asked[0].id, out: 2 });
    await expect(talking).resolves.toBe(2);
    pool.close();
  });

  it("does not hold a worker with nothing to do to the limit", async () => {
    vi.useFakeTimers();
    const { made, make, answer } = workers();
    const pool = poolOf<number, number>(make, 1);
    const piece = pool.run(1);
    answer(0, { id: made[0].asked[0].id, out: 1 });
    await piece;
    vi.advanceTimersByTime(10 * SILENT_MS);
    expect(made[0].stopped).toBe(false);
    pool.close();
  });

  it("fails at once what is asked after it closed", async () => {
    const { make } = workers();
    const pool = poolOf<number, number>(make, 1);
    pool.close();
    await expect(pool.run(1)).rejects.toThrow("closed");
  });
});

describe("checkPiecesOf", () => {
  it("does here the piece of a worker that dies, from sound the worker never touched", async () => {
    const { make, made } = workers();
    const pool = poolOf<PieceInput, PieceOutput>(make, 2);
    const samples = Float32Array.from({ length: 8000 }, (_, i) => Math.sin((2 * Math.PI * 100 * i) / 8000));
    const curve = { times: Float64Array.of(0, 1), freq: Float64Array.of(100, 100) };
    const piece = checkPiecesOf(pool).takeOut({ channels: [samples], rate: 8000, rounds: [[curve]], scrub: { fill: false } }, () => {});
    made[0].onerror?.(death("no room"));
    const [out] = await piece;
    const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak(out.subarray(2000, 6000))).toBeLessThan(0.1);
    pool.close();
  });
});
