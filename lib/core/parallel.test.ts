import { describe, expect, it } from "vitest";
import { inOrder, inParallel } from "./parallel";

describe("inParallel", () => {
  it("keeps the items' order whatever order they finish in, and holds to the cap", async () => {
    let running = 0;
    let most = 0;
    const waiting: (() => void)[] = [];
    const items = [0, 1, 2, 3, 4, 5, 6];
    const all = inParallel(items, 3, async (x) => {
      most = Math.max(most, ++running);
      await new Promise<void>((go) => waiting.push(go));
      running--;
      return x * 2;
    });
    // Finish the latest started first, as a slow network would.
    while (waiting.length || running) {
      await Promise.resolve();
      waiting.pop()?.();
      await new Promise((go) => setImmediate(go));
    }
    expect(await all).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(most).toBe(3);
  });

  it("does nothing for no items", async () => {
    expect(await inParallel([], 4, async () => 1)).toEqual([]);
  });

  it("fails when an item fails", async () => {
    await expect(
      inParallel([1, 2], 2, async (x) => {
        if (x === 2) throw new Error("no");
        return x;
      }),
    ).rejects.toThrow("no");
  });
});

describe("inOrder", () => {
  /** Work the test ends by hand. */
  function hand() {
    const ends: ((value: number) => void)[] = [];
    const start = () => new Promise<number>((resolve) => void ends.push(resolve));
    return { ends, start };
  }

  it("hands results out in the items' order, whichever ends first", async () => {
    const { ends, start } = hand();
    const out = inOrder([0, 1, 2], 3, start);
    const first = out.next();
    for (let wait = 0; wait < 20; wait++) await null;
    expect(ends.length).toBe(3);
    ends[2](2);
    for (let wait = 0; wait < 20; wait++) await null;
    ends[1](1);
    ends[0](0);
    expect((await first).value).toBe(0);
    expect((await out.next()).value).toBe(1);
    expect((await out.next()).value).toBe(2);
    expect((await out.next()).done).toBe(true);
  });

  it("takes items as they come, the next one before the result of the one ahead", async () => {
    const log: string[] = [];
    async function* items() {
      for (let i = 0; i < 4; i++) {
        log.push(`take ${i}`);
        yield i;
      }
    }
    for await (const x of inOrder(items(), 1, async (i) => i)) log.push(`out ${x}`);
    expect(log).toEqual(["take 0", "take 1", "out 0", "take 2", "out 1", "take 3", "out 2", "out 3"]);
  });

  it("says a failure in its turn, and stops taking items when told to", async () => {
    let taken = 0;
    function* items() {
      for (let i = 0; i < 100; i++) {
        taken++;
        yield i;
      }
    }
    const out = inOrder(items(), 1, async (i) => {
      if (i === 1) throw new Error("no");
      return i;
    });
    expect((await out.next()).value).toBe(0);
    await expect(out.next()).rejects.toThrow("no");
    expect((await out.next()).done).toBe(true);
    expect(taken).toBeLessThan(4);
  });
});
