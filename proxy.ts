import { NextResponse, type NextRequest } from "next/server";
import { negotiate } from "@/lib/i18n/lang";

// The bare address serves the visitor's language without changing the URL (a rewrite, not a
// redirect: the QR code and shared links stay unheard.gwendall.com). /en and /fr are each
// language's own address.
export function proxy(request: NextRequest) {
  const lang = negotiate(request.headers.get("accept-language"));
  const url = request.nextUrl.clone();
  url.pathname = `/${lang}${url.pathname === "/" ? "" : url.pathname}`;
  const res = NextResponse.rewrite(url);
  res.headers.set("Vary", "Accept-Language");
  return res;
}

export const config = { matcher: ["/", "/privacy"] };
