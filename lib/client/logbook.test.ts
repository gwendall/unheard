import { describe, expect, it } from "vitest";
import { addToLog, clearLog, KEY, readLog, summary, type Entry } from "./logbook";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const entry = (over: Partial<Entry> = {}): Entry => ({ at: 1_000_000, hex: "3c6444", title: "Cessna 172 Skyhawk", kind: "model", sure: true, range: 690, height: 550, route: null, ...over });

describe("logbook", () => {
  it("keeps finds newest first", () => {
    const s = memory();
    addToLog(s, entry({ at: 1, hex: "a" }));
    addToLog(s, entry({ at: 3_000_000, hex: "b" }));
    expect(readLog(s).map((e) => e.hex)).toEqual(["b", "a"]);
  });
  it("counts a second result for the same flyby once, and a later pass again", () => {
    const s = memory();
    addToLog(s, entry({ at: 0, range: 900 }));
    addToLog(s, entry({ at: 5 * 60_000, range: 700 }));
    expect(readLog(s)).toHaveLength(1);
    expect(readLog(s)[0].range).toBe(700);
    addToLog(s, entry({ at: 60 * 60_000 }));
    expect(readLog(s)).toHaveLength(2);
  });
  it("survives a corrupt or foreign value", () => {
    const s = memory();
    s.setItem(KEY, "{not json");
    expect(readLog(s)).toEqual([]);
    s.setItem(KEY, JSON.stringify([{ hex: 1 }, entry()]));
    expect(readLog(s)).toHaveLength(1);
  });
  it("keeps the result when storage refuses to write", () => {
    const s = { ...memory(), setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(addToLog(s, entry())).toHaveLength(1);
  });
  it("clears", () => {
    const s = memory();
    addToLog(s, entry());
    clearLog(s);
    expect(readLog(s)).toEqual([]);
  });
  it("sums up finds, aircraft and the closest", () => {
    const log = [entry({ hex: "a", range: 900 }), entry({ hex: "a", at: 9e9, range: 400 }), entry({ hex: "b", range: 2000 })];
    const s = summary(log);
    expect(s).toMatchObject({ finds: 3, aircraft: 2 });
    expect(s.closest?.range).toBe(400);
    expect(summary([]).closest).toBeNull();
  });
});
