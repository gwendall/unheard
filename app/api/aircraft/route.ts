import { slimPoll, type Poll } from "@/lib/adsb";
import { areaQuery, FRESH_FOR, RADIUS_NM, snap, STALE_FOR } from "@/lib/area";

// The aircraft of one area of the grid (lib/area.ts): every listener of a square shares one URL,
// one CDN entry and one upstream request every 2 s, at most. The CDN cache is regional and does
// not collapse a burst on a function, so this file keeps its own short memory of each area too.

const SHARED = `public, s-maxage=${FRESH_FOR}, stale-if-error=${STALE_FOR}`;
/** A position off the grid (a page older than it, or a script) costs a redirect and no upstream request. */
const REDIRECT = "public, s-maxage=86400";

/** adsb.lol and adsb.fi limit each address: after a 429 this instance leaves that one alone for a while. */
const REFUSED_FOR = 10_000;

const SOURCES = [
  { url: (lat: number, lon: number) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${RADIUS_NM}`, refusedUntil: 0 },
  { url: (lat: number, lon: number) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`, refusedUntil: 0 },
];

async function askUpstream(lat: number, lon: number): Promise<Poll | null> {
  for (const source of SOURCES) {
    if (Date.now() < source.refusedUntil) continue;
    try {
      const res = await fetch(source.url(lat, lon), { signal: AbortSignal.timeout(4000), cache: "no-store" });
      if (res.status === 429) source.refusedUntil = Date.now() + REFUSED_FOR;
      if (res.ok) return slimPoll(await res.json());
    } catch {
      // Next source.
    }
  }
  return null;
}

type Area = { askedAt: number; answer: Promise<Poll | null> };

/** The last request of each area, oldest first. */
const areas = new Map<string, Area>();

/** The area's answer: a request under 2 s old is shared, and a refusal falls back on the last poll while it is recent. */
function pollOf(key: string, lat: number, lon: number): Promise<Poll | null> {
  const now = Date.now();
  const last = areas.get(key);
  if (last && now - last.askedAt < FRESH_FOR * 1000) return last.answer;
  for (const [k, area] of areas) {
    if (now - area.askedAt < STALE_FOR * 1000) break;
    areas.delete(k);
  }
  const answer = askUpstream(lat, lon).then(async (poll) => {
    if (poll) return poll;
    const previous = last ? await last.answer : null;
    return previous && Date.now() - previous.now < STALE_FOR * 1000 ? previous : null;
  });
  areas.delete(key);
  areas.set(key, { askedAt: now, answer });
  return answer;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat") ?? NaN);
  const lon = Number(url.searchParams.get("lon") ?? NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: "lat and lon are required" }, { status: 400 });
  }
  const area = areaQuery(lat, lon);
  if (url.searchParams.get("lat") !== String(snap(lat)) || url.searchParams.get("lon") !== String(snap(lon))) {
    return new Response(null, { status: 308, headers: { Location: `/api/aircraft${area}`, "Cache-Control": REDIRECT } });
  }
  const poll = await pollOf(area, snap(lat), snap(lon));
  if (!poll) return Response.json({ error: "flight data unavailable" }, { status: 502 });
  return Response.json(poll, { headers: { "Cache-Control": SHARED } });
}
