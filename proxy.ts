import { NextResponse, type NextRequest } from "next/server";

// The bare address serves the visitor's language without changing the URL (a rewrite, not a
// redirect: the QR code and shared links stay unheard.gwendall.com). /en and /fr are each
// language's own address. Negotiation is off until the whole app speaks French: English for now.
export function proxy(request: NextRequest) {
  const lang = "en";
  const url = request.nextUrl.clone();
  url.pathname = `/${lang}${url.pathname === "/" ? "" : url.pathname}`;
  const res = NextResponse.rewrite(url);
  res.headers.set("Vary", "Accept-Language");
  return res;
}

export const config = { matcher: ["/", "/privacy"] };
