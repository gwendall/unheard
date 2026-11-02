import { slimPoll } from "@/lib/adsb";

// The aircraft within 16 nautical miles (30 km) of a point rounded to 0.1 degree: the listener's
// precise location never reaches us, and nearby listeners share one cached answer. The radius
// covers anything audible (15 km) from anywhere in the rounded cell.
const RADIUS_NM = 16;

const SOURCES = [
  (lat: number, lon: number) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${RADIUS_NM}`,
  (lat: number, lon: number) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`,
];

const round = (x: number) => Math.round(x * 10) / 10;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: "lat and lon are required" }, { status: 400 });
  }
  for (const source of SOURCES) {
    try {
      const res = await fetch(source(round(lat), round(lon)), { signal: AbortSignal.timeout(4000), cache: "no-store" });
      if (!res.ok) continue;
      const poll = slimPoll(await res.json());
      return Response.json(poll, { headers: { "Cache-Control": "public, s-maxage=1, stale-while-revalidate=1" } });
    } catch {
      // Next source.
    }
  }
  return Response.json({ error: "flight data unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
}
