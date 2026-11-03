import type { NextConfig } from "next";
import { DEFAULT_LOCALE, LANG_COOKIE, LOCALES } from "./lib/locales";

// English is the site at /, every other language under its code (lib/locales.ts): /fr,
// /fr/privacy. Inside, English lives at /en: its pages are rewritten there, and /en/... answers
// with a permanent redirect to the page without it. A first visit goes to the browser's first
// language when the site has it; after that, to the one picked in the language menu (the
// unheard-lang cookie, English included). Link previews and crawlers always get the page they
// asked for.
const PAGES = ["", "/privacy", "/somewhere-else", "/where"];
const OTHER = LOCALES.filter((code) => code !== DEFAULT_LOCALE).join("|");
// The first language of Accept-Language: "fr-FR,fr;q=0.9,en;q=0.8" is French.
const FIRST = `(?<lang>${OTHER})(?:-[^,;]*)?(?:[,;].*)?`;
const CHOSEN = { type: "cookie", key: LANG_COOKIE } as const;
const BOT = {
  type: "header",
  key: "user-agent",
  value: ".*(?:[Bb]ot|[Cc]rawl|[Ss]pider|[Pp]review|facebookexternalhit|WhatsApp|Slack|Discord|Telegram|Twitter|LinkedIn|Embedly|Lighthouse).*",
} as const;

const nextConfig: NextConfig = {
  reactCompiler: true,
  typedRoutes: true,
  // The link preview reads its fonts from disk: ship them with its routes, and only them.
  outputFileTracingIncludes: {
    "/opengraph-image": ["./assets/fonts/**/*"],
    "/twitter-image": ["./assets/fonts/**/*"],
  },
  async rewrites() {
    return {
      beforeFiles: PAGES.map((page) => ({ source: page || "/", destination: `/${DEFAULT_LOCALE}${page}` })),
      afterFiles: [],
      fallback: [],
    };
  },
  async redirects() {
    // The check became part of the one flow for a file, at /where.
    const moved = [
      { source: "/check", destination: "/where", permanent: true },
      { source: `/:lang(${OTHER}|${DEFAULT_LOCALE})/check`, destination: "/:lang/where", permanent: true },
    ];
    return [...moved, ...PAGES.flatMap((page) => [
      { source: `/${DEFAULT_LOCALE}${page}`, destination: page || "/", permanent: true },
      { source: page || "/", has: [{ ...CHOSEN, value: `(?<lang>${OTHER})` }], missing: [BOT], destination: `/:lang${page}`, permanent: false },
      { source: page || "/", has: [{ type: "header", key: "accept-language", value: FIRST } as const], missing: [CHOSEN, BOT], destination: `/:lang${page}`, permanent: false },
    ])];
  },
  async headers() {
    return [
      // The page asks for the microphone and the location, nothing else, and never inside a frame.
      {
        source: "/:path*",
        headers: [
          { key: "Permissions-Policy", value: "microphone=(self), geolocation=(self), camera=()" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
