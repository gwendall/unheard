import type { Locale } from "./locales";

// messages/<code>.json is written with plain spaces, easy to edit. Some languages want others:
// French puts a no-break space before : and inside « », a thin one before ; ? ! and between
// thousands (8 000), so a sign never starts a line on a narrow phone. messages() in lib/i18n.ts
// reads every string of a language through its rule.

const NBSP = " ";
const THIN = " ";

export function frenchSpacing(s: string): string {
  return s
    .replace(/ ([;?!])/g, `${THIN}$1`)
    .replace(/ :/g, `${NBSP}:`)
    .replace(/« /g, `«${NBSP}`)
    .replace(/ »/g, `${NBSP}»`)
    .replace(/(\d) (\d{3})\b/g, `$1${THIN}$2`);
}

const RULES: Partial<Record<Locale, (s: string) => string>> = { fr: frenchSpacing };

/** Every string of a messages tree through the language's rule, arrays, objects and numbers kept as they are. */
export function typeset<T>(locale: Locale, value: T): T {
  const rule = RULES[locale];
  if (!rule) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return rule(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
