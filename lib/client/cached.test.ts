import { describe, expect, it } from "vitest";
import { cachedBytes, type Keep } from "./cached";

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
