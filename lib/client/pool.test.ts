import { describe, expect, it } from "vitest";
import { poolOf, poolSize, type Piece, type PieceReply, type PoolWorker } from "./pool";

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
  it("leaves a core to the page, has a ceiling, and gives little memory two", () => {
    expect(poolSize(1)).toBe(1);
    expect(poolSize(2)).toBe(1);
    expect(poolSize(4)).toBe(3);
    expect(poolSize(18)).toBe(6);
    expect(poolSize(8, 4)).toBe(2);
    expect(poolSize(8, 8)).toBe(6);
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
