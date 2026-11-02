// Ground elevation and air temperature at the listener (Open-Meteo, no key). The temperature sets
// the speed of sound; the elevation, how high the aircraft are above the microphone.

const round = (x: number) => Math.round(x * 1000) / 1000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: "lat and lon are required" }, { status: 400 });
  }
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${round(lat)}&longitude=${round(lon)}&current=temperature_2m`, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { elevation?: number; current?: { temperature_2m?: number } };
    return Response.json(
      { elevation: data.elevation ?? null, temperatureC: data.current?.temperature_2m ?? null },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=600" } },
    );
  } catch {
    return Response.json({ elevation: null, temperatureC: null }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
