import { describe, expect, it } from "vitest";
import { inParallel } from "./parallel";

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
