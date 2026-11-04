import { afterEach, describe, expect, it, vi } from "vitest";
import { planArchive, type TileIn } from "../../scripts/pmtiles-write";
import { cachedBytes, cachedTiles, type Keep } from "./cached";

const WEEK = 7 * 86_400_000;

/** A cache in memory, a network that counts, a clock the test steps. */
function world(serving: Record<string, Uint8Array> = {}) {
  const held = new Map<string, Response>();
  const state = { now: 1_000_000, fetched: 0, refused: false };
  const keep: Keep = {
    open: async () => ({
      match: (async (url: string) => held.get(url)?.clone()) as unknown as Cache["match"],
      put: (async (url: string, res: Response) => {
        if (state.refused) throw new Error("no room");
        held.set(url, res);
      }) as unknown as Cache["put"],
      keys: (async () => [...held.keys()].map((url) => ({ url }))) as unknown as Cache["keys"],
      delete: (async (r: { url: string }) => held.delete(r.url)) as unknown as Cache["delete"],
    }),
    fetch: async (url) => {
      state.fetched++;
      const bytes = serving[url];
      return bytes ? new Response(bytes as BlobPart) : new Response(null, { status: 404 });
    },
    now: () => state.now,
  };
  return { keep, state, held };
}

const bytes = Uint8Array.of(1, 2, 3);

describe("cachedBytes", () => {
  it("goes to the network once, then reads what it kept", async () => {
    const { keep, state } = world({ a: bytes });
    expect(await cachedBytes("a", keep)).toEqual(bytes);
    expect(await cachedBytes("a", keep)).toEqual(bytes);
    expect(state.fetched).toBe(1);
  });

  it("keeps nothing of what the server does not have", async () => {
    const { keep, state, held } = world();
    expect(await cachedBytes("a", keep)).toBeNull();
    expect(await cachedBytes("a", keep)).toBeNull();
    expect(state.fetched).toBe(2);
    expect(held.size).toBe(0);
  });

  it("reads a tile again after a week", async () => {
    const { keep, state } = world({ a: bytes });
    await cachedBytes("a", keep);
    state.now += WEEK - 1;
    await cachedBytes("a", keep);
    expect(state.fetched).toBe(1);
    state.now += 1;
    await cachedBytes("a", keep);
    expect(state.fetched).toBe(2);
  });

  it("drops the oldest past its limit", async () => {
    const serving = Object.fromEntries(Array.from({ length: 302 }, (_, i) => [`t${i}`, bytes]));
    const { keep, held } = world(serving);
    for (const url of Object.keys(serving)) await cachedBytes(url, keep);
    expect(held.size).toBe(300);
    expect(held.has("t0")).toBe(false);
    expect(held.has("t301")).toBe(true);
  });

  it("still gives the bytes when the cache is missing or refuses", async () => {
    const refused = world({ a: bytes });
    refused.state.refused = true;
    expect(await cachedBytes("a", refused.keep)).toEqual(bytes);
    const none = world({ a: bytes });
    expect(await cachedBytes("a", { ...none.keep, open: async () => null })).toEqual(bytes);
  });
});

describe("cachedTiles", () => {
  const BASE = "https://bucket.example/";
  const bytesOf = (tile: TileIn) => Uint8Array.from({ length: tile.length }, (_, i) => (i + tile.x) & 0xff);
  const tiles: TileIn[] = [
    { z: 10, x: 163, y: 395, length: 500, content: "a" },
    { z: 10, x: 164, y: 395, length: 700, content: "b" },
  ];

  /** The file behind a fetch that answers ranges, and writes down what it was asked. */
  function serveFile() {
    const plan = planArchive(tiles, { name: "test" });
    const file = Buffer.concat([plan.head, ...plan.stored.map((s) => bytesOf(s.tile))]);
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      asked.push(request.url);
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "")!;
      const body = file.subarray(Number(from), Number(to) + 1);
      return new Response(body, { status: 206, headers: { "content-length": String(body.length), "content-range": `bytes ${from}-${to}/${file.length}`, etag: '"x"' } });
    });
    return asked;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("reads a tile by ranges from our own file only, byte for byte", async () => {
    const asked = serveFile();
    const { keep } = world();
    const read = cachedTiles(BASE, keep);
    expect(await read(10, 163, 395)).toEqual(bytesOf(tiles[0]));
    expect(await read(10, 164, 395)).toEqual(bytesOf(tiles[1]));
    expect(new Set(asked)).toEqual(new Set([`${BASE}terrain/terrarium-z10.pmtiles`]));
  });

  it("does not go back to the network for a tile it holds", async () => {
    const asked = serveFile();
    const { keep } = world();
    await cachedTiles(BASE, keep)(10, 163, 395);
    const before = asked.length;
    expect(await cachedTiles(BASE, keep)(10, 163, 395)).toEqual(bytesOf(tiles[0]));
    expect(asked.length).toBe(before);
  });

  it("gives nothing for a tile the file does not have", async () => {
    serveFile();
    const { keep } = world();
    expect(await cachedTiles(BASE, keep)(10, 500, 500)).toBeNull();
  });
});
