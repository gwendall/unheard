import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daysToBuild, IMMUTABLE, publishDay, refreshDays, SHORT, type Store } from "../scripts/history-job";

/** A bucket in memory that remembers the order of the uploads, and can fail on one key. */
function fakeStore(failOn?: string) {
  const keys = new Map<string, { body: Uint8Array; cache: string }>();
  const order: string[] = [];
  const store: Store = {
    has: async (key) => keys.has(key),
    put: async (key, body, _type, cache) => {
      if (key === failOn) throw new Error(`PUT ${key}: HTTP 500`);
      keys.set(key, { body, cache });
      order.push(key);
    },
    folders: async () => [...new Set([...keys.keys()].filter((k) => k.includes("/")).map((k) => k.split("/")[0]))],
    allowAnyOrigin: async () => {},
  };
  return { store, keys, order };
}

/** A built day on disk, as the builder leaves it. */
function builtDay(day: string, tiles: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "history-job-"));
  mkdirSync(join(dir, day));
  for (const t of tiles) writeFileSync(join(dir, day, `${t}.bin.gz`), t);
  writeFileSync(join(dir, day, "build.json"), "{}");
  writeFileSync(join(dir, day, "manifest.json"), JSON.stringify({ day, tiles: Object.fromEntries(tiles.map((t) => [t, {}])) }));
  return dir;
}

describe("the days to try", () => {
  const now = new Date("2026-01-05T22:00:00Z");

  it("goes from yesterday back to the oldest day", () => {
    expect(daysToBuild(now, { oldest: "2026-01-02" })).toEqual(["2026-01-04", "2026-01-03", "2026-01-02"]);
  });

  it("puts the days asked first, once", () => {
    expect(daysToBuild(now, { first: ["2026-01-02"], oldest: "2026-01-01" })).toEqual(["2026-01-02", "2026-01-04", "2026-01-03", "2026-01-01"]);
  });

  it("shares the list between machines without overlap", () => {
    const parts = [0, 1, 2].map((i) => daysToBuild(now, { oldest: "2026-01-01", shard: [i, 3] }));
    expect(parts.flat().sort()).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
  });
});

describe("publishing a day", () => {
  const tiles = ["37_-122", "40_-75", "40.5_-75"];

  it("uploads the manifest last, every file immutable", async () => {
    const { store, keys, order } = fakeStore();
    await publishDay(store, builtDay("2026-05-16", tiles), "2026-05-16");
    expect(order.at(-1)).toBe("2026-05-16/manifest.json");
    expect(order).toHaveLength(tiles.length + 2);
    expect([...keys.values()].every((k) => k.cache === IMMUTABLE)).toBe(true);
  });

  it("leaves no manifest when a tile fails", async () => {
    const { store, keys } = fakeStore("2026-05-16/40_-75.bin.gz");
    await expect(publishDay(store, builtDay("2026-05-16", tiles), "2026-05-16")).rejects.toThrow("HTTP 500");
    expect(keys.has("2026-05-16/manifest.json")).toBe(false);
  });

  it("leaves no manifest when a tile is missing from the build", async () => {
    const { store, keys } = fakeStore();
    const dir = builtDay("2026-05-16", tiles);
    writeFileSync(join(dir, "2026-05-16", "manifest.json"), JSON.stringify({ day: "2026-05-16", tiles: { "1_1": {} } }));
    await expect(publishDay(store, dir, "2026-05-16")).rejects.toThrow();
    expect(keys.has("2026-05-16/manifest.json")).toBe(false);
  });

  it("lists only the days whose manifest is there, on a short cache", async () => {
    const { store, keys } = fakeStore("2026-05-17/manifest.json");
    await publishDay(store, builtDay("2026-05-16", tiles), "2026-05-16");
    await publishDay(store, builtDay("2026-05-17", tiles), "2026-05-17").catch(() => {});
    expect(await refreshDays(store)).toEqual(["2026-05-16"]);
    const listing = keys.get("days.json")!;
    expect(listing.cache).toBe(SHORT);
    expect(JSON.parse(new TextDecoder().decode(listing.body))).toMatchObject({ licence: "ODbL-1.0", attribution: "© adsb.lol contributors", days: ["2026-05-16"] });
  });
});
