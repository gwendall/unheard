// The languages of the site, and which one a visitor gets at the bare address.

export const LANGS = ["en", "fr"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "en";

export const isLang = (s: string | undefined | null): s is Lang => (LANGS as readonly string[]).includes(s ?? "");

/** BCP 47 tag for numbers and dates. */
export const locale = (lang: Lang) => (lang === "fr" ? "fr-FR" : "en-US");

/**
 * The visitor's language from an Accept-Language header: the first of ours they list, by their
 * own order of preference, else English. "fr-CA;q=0.8, en;q=0.9" gives English.
 */
export function negotiate(header: string | null | undefined): Lang {
  if (!header) return DEFAULT_LANG;
  const asked = header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { base: tag.trim().toLowerCase().split("-")[0], weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((a) => a.base && a.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  return asked.find((a) => isLang(a.base))?.base as Lang | undefined ?? DEFAULT_LANG;
}
