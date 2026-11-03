// A photo of the aircraft from planespotters.net, by its ICAO address. Their API answers servers,
// not pages on other sites, hence this route. One lookup per result, cached for a day.

const HEX = /^[0-9a-f]{6}$/;

type Answer = { photos?: { thumbnail_large?: { src?: string; size?: { width?: number; height?: number } }; link?: string; photographer?: string }[] };

export async function GET(request: Request) {
  const hex = new URL(request.url).searchParams.get("hex")?.toLowerCase() ?? "";
  if (!HEX.test(hex)) return Response.json({ error: "hex is required" }, { status: 400 });
  try {
    const res = await fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`, {
      headers: { "User-Agent": "unheard (+https://unheard.gwendall.com)" },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const p = ((await res.json()) as Answer).photos?.[0];
    const t = p?.thumbnail_large;
    const photo = t?.src && p?.link && p.photographer ? { src: t.src, width: t.size?.width ?? 498, height: t.size?.height ?? 280, link: p.link, photographer: p.photographer } : null;
    return Response.json({ photo }, { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=86400" } });
  } catch {
    return Response.json({ photo: null }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
