import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collect, type Poll, type PolledAircraft } from "./adsb";
import { areaQuery, FRESH_FOR, GRID, RADIUS_NM, REACH, snap, STALE_FOR } from "./area";
import { nearbyFrom } from "./client/nearby";
import { pollAround, RECORD_EVERY } from "./client/sky";
import { buildTrack } from "./core/track";

const T0 = Date.UTC(2026, 10, 4, 17, 0, 0);
const AREA = "?lat=48.75&lon=2.25";
const request = (query: string) => new Request(`https://unheard.test/api/aircraft${query}`);

const RAD = Math.PI / 180;
/** Great-circle distance, metres: how the upstream services read a radius. */
function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const s = Math.sin(((b.lat - a.lat) * RAD) / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(((b.lon - a.lon) * RAD) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(s));
}

const plane = (hex: string, lat: number, lon: number, more: Partial<PolledAircraft> = {}): PolledAircraft => ({ hex, lat, lon, alt_geom: 3000, gs: 100, track: 90, ...more });

/** The upstream services: answers `reply(url)`, or their usual answer with the clock of now. */
function stubUpstream(reply?: (url: string) => Response | undefined) {
  const upstream = vi.fn(async (url: string) => reply?.(url) ?? Response.json({ now: Date.now(), ac: [plane("abc123", 48.8, 2.3)] }));
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

const refused = () => new Response("slow down", { status: 429 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  // The route remembers areas and refusals in its module: each test starts a new instance.
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function route() {
  return (await import("@/app/api/aircraft/route")).GET;
}

describe("the grid", () => {
  it("gives neighbours one address, whatever the digits of their position", () => {
    expect(areaQuery(48.8123, 2.2987)).toBe(AREA);
    expect(areaQuery(48.6951, 2.1502)).toBe(AREA);
    expect(areaQuery(-33.87, 151.21)).toBe("?lat=-33.75&lon=151.25");
    expect(areaQuery(-0.04, 0.04)).toBe("?lat=0&lon=0");
  });

  it("asks a circle that covers REACH around a listener at the very corner of a square, at any latitude", () => {
    for (const lat of [-80, -45.25, -10, 0, 0.25, 30, 48.75, 70]) {
      for (const [dlat, dlon] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const listener = { lat: lat + (dlat * GRID) / 2 - dlat * 1e-9, lon: 10.25 + (dlon * GRID) / 2 - dlon * 1e-9 };
        const centre = { lat: snap(listener.lat), lon: snap(listener.lon) };
        expect(distance(listener, centre) + REACH).toBeLessThanOrEqual(RADIUS_NM * 1852);
      }
    }
  });
});

describe("what the page keeps of the shared answer", () => {
  it("sends only the square, and keeps the planes within REACH of the true position", async () => {
    const listener = { lat: 48.8749, lon: 2.3749 };
    // 31 km and 29 km east of the listener: the first is in the area's answer, not in their sky.
    const east = (metres: number) => listener.lon + metres / (distance(listener, { lat: listener.lat, lon: listener.lon + 1 }));
    const near = plane("near", listener.lat, east(29_000));
    const far = plane("far", listener.lat, east(31_000));
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return Response.json({ now: T0, aircraft: [near, far] });
    });
    const poll = await pollAround(listener.lat, listener.lon);
    expect(asked).toEqual(["/api/aircraft?lat=48.75&lon=2.25"]);
    expect(poll.now).toBe(T0);
    expect(poll.aircraft.map((a) => a.hex)).toEqual(["near"]);
  });

  it("reads a poll at its own age: the countdown and the distance are those of now, not of the poll", () => {
    const listener = { lat: 48.75, lon: 2.25, elevation: 0 };
    // 5 km west, flying east at 100 kt (51 m/s).
    const poll: Poll = { now: T0, aircraft: [plane("abc123", 48.75, 2.25 - 5000 / 73_000)] };
    const fresh = nearbyFrom(poll, listener, 6, T0)[0];
    const old = nearbyFrom(poll, listener, 6, T0 + 30_000)[0];
    expect(old.closestIn).toBeCloseTo(fresh.closestIn - 30, 3);
    expect(old.closestAt).toBeCloseTo(fresh.closestAt, 3);
    expect(old.distance).toBeLessThan(fresh.distance - 500);
    // A phone an hour off is not believed.
    expect(nearbyFrom(poll, listener, 6, T0 + 3_600_000)[0].closestIn).toBeCloseTo(fresh.closestIn, 6);
    expect(nearbyFrom(poll, listener, 6, T0 - 3_600_000)[0].closestIn).toBeCloseTo(fresh.closestIn, 6);
  });

  it("gets no false fix from the same answer served twice: its time is the upstream one", () => {
    const listener = { lat: 48.75, lon: 2.25, elevation: 0 };
    const poll: Poll = { now: T0, aircraft: [plane("abc123", 48.8, 2.3)] };
    const { fixes } = collect([poll, poll]).get("abc123")!;
    expect(fixes.map((f) => f.t)).toEqual([T0 / 1000, T0 / 1000]);
    expect(buildTrack(fixes, listener)!.points).toHaveLength(1);
  });
});

describe("/api/aircraft", () => {
  it("makes one upstream request for a burst of listeners of an area, and marks the answer for the CDN", async () => {
    const upstream = stubUpstream();
    const GET = await route();
    const answers = await Promise.all(Array.from({ length: 200 }, () => GET(request(AREA))));
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe(`https://api.adsb.lol/v2/point/48.75/2.25/${RADIUS_NM}`);
    for (const a of answers) {
      expect(a.status).toBe(200);
      expect(a.headers.get("Cache-Control")).toBe(`public, s-maxage=${FRESH_FOR}, stale-if-error=${STALE_FOR}`);
    }
    expect(((await answers[199].json()) as Poll).now).toBe(T0);
  });

  it("asks again after 2 s, not before, and once per area", async () => {
    const upstream = stubUpstream();
    const GET = await route();
    await GET(request(AREA));
    await GET(request("?lat=40.75&lon=-74"));
    expect(upstream).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + FRESH_FOR * 1000 - 1);
    await GET(request(AREA));
    expect(upstream).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + FRESH_FOR * 1000);
    await GET(request(AREA));
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("sends any other spelling of an area to its one address without asking upstream", async () => {
    const upstream = stubUpstream();
    const GET = await route();
    for (const query of ["?lat=48.8&lon=2.3", "?lon=2.25&lat=48.75", `${AREA}&x=1`, "?lat=48.750&lon=2.25"]) {
      const res = await GET(request(query));
      expect(res.status).toBe(308);
      expect(res.headers.get("Location")).toBe(`/api/aircraft${AREA}`);
      expect(res.headers.get("Cache-Control")).toContain("s-maxage");
    }
    expect((await GET(request("?lat=48.75"))).status).toBe(400);
    expect((await GET(request("?lat=91&lon=2.25"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("goes to the fallback after a 429 and leaves the service that refused alone for 10 s", async () => {
    const upstream = stubUpstream((url) => (url.includes("adsb.lol") ? refused() : undefined));
    const GET = await route();
    expect((await GET(request(AREA))).status).toBe(200);
    expect(upstream.mock.calls.map(([url]) => new URL(url).host)).toEqual(["api.adsb.lol", "opendata.adsb.fi"]);
    upstream.mockClear();
    vi.setSystemTime(T0 + 9_000);
    expect((await GET(request("?lat=40.75&lon=-74"))).status).toBe(200);
    expect(upstream.mock.calls.map(([url]) => new URL(url).host)).toEqual(["opendata.adsb.fi"]);
    upstream.mockClear();
    vi.setSystemTime(T0 + 10_000);
    await GET(request("?lat=35&lon=139.75"));
    expect(upstream.mock.calls.map(([url]) => new URL(url).host)[0]).toBe("api.adsb.lol");
  });

  it("answers with the last poll when upstream refuses, its time unchanged, for a minute", async () => {
    let refusing = false;
    const upstream = stubUpstream(() => (refusing ? refused() : undefined));
    const GET = await route();
    await GET(request(AREA));
    refusing = true;

    vi.setSystemTime(T0 + 30_000);
    const stale = await GET(request(AREA));
    expect(stale.status).toBe(200);
    expect(stale.headers.get("Cache-Control")).toContain("s-maxage");
    expect(((await stale.json()) as Poll).now).toBe(T0);

    // Both services are left alone while they refuse: the next area costs nothing and has nothing to show.
    upstream.mockClear();
    vi.setSystemTime(T0 + 32_000);
    const cold = await GET(request("?lat=40.75&lon=-74"));
    expect(cold.status).toBe(502);
    expect(cold.headers.get("Cache-Control") ?? "").not.toContain("s-maxage");
    expect(upstream).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + (STALE_FOR + 1) * 1000);
    expect((await GET(request(AREA))).status).toBe(502);
  });
});

/**
 * The CDN as its documentation describes it, in front of the route: one entry per URL, kept for
 * the s-maxage of the answer, counted from the moment the answer reaches it. Not the real one:
 * this measures what the headers and the page's cadence ask of it. `every` in milliseconds.
 */
async function listenThroughCdn(listeners: number, seconds: number, every: number) {
  const upstream = stubUpstream();
  const GET = await route();
  const events: { at: number; who: number }[] = [];
  for (let who = 0; who < listeners; who++) {
    for (let at = T0 + ((who * 0.618) % 1) * every; at < T0 + seconds * 1000; at += every) events.push({ at, who });
  }
  events.sort((a, b) => a.at - b.at);
  const LATENCY = 300;
  const cache = new Map<string, { storedAt: number; ttl: number; body: Poll }>();
  const seen = Array.from({ length: listeners }, () => new Set<number>());
  for (const { at, who } of events) {
    vi.setSystemTime(at);
    let entry = cache.get(AREA);
    if (!entry || at - entry.storedAt >= entry.ttl) {
      const res = await GET(request(AREA));
      const ttl = Number(/s-maxage=(\d+)/.exec(res.headers.get("Cache-Control")!)![1]) * 1000;
      entry = { storedAt: at + LATENCY, ttl, body: (await res.json()) as Poll };
      cache.set(AREA, entry);
    }
    seen[who].add(entry.body.now);
  }
  return { upstream: upstream.mock.calls.length, polls: events.length, seen };
}

describe("one area, through the CDN", () => {
  it("costs one upstream request every 2 s at most, however many listen", async () => {
    const { upstream, polls, seen } = await listenThroughCdn(200, 60, RECORD_EVERY);
    expect(polls).toBeGreaterThanOrEqual(3990);
    expect(upstream).toBeLessThanOrEqual(30 + 1);
    // Sharing takes nothing from the listeners: a new position on every poll.
    for (const s of seen) expect(s.size).toBeGreaterThanOrEqual(19);
  });

  it("gives a listener alone a new position on every poll at the recording's pace", async () => {
    const { upstream, polls, seen } = await listenThroughCdn(1, 60, RECORD_EVERY);
    expect(seen[0].size).toBe(polls);
    expect(upstream).toBe(polls);
    expect(RECORD_EVERY).toBeGreaterThan(FRESH_FOR * 1000);
  });

  it("would give them one only every other poll at 2 s: why the recording polls every 3 s", async () => {
    const { polls, seen } = await listenThroughCdn(1, 60, 2000);
    expect(seen[0].size).toBeLessThanOrEqual(Math.ceil(polls / 2));
  });
});
