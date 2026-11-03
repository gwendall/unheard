// The site's languages. English lives at /, every other one under its code: /fr, /fr/privacy.
// Safe for the browser: the messages themselves load in lib/i18n.ts. Adding a language is its
// messages/<code>.json and a line in LOCALES and LANGUAGES; next.config.ts reads the list.
export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

// `tag` is the page's lang and hreflang and what Intl formats numbers and dates with, `og` Open
// Graph's locale, `name` what the language menu shows, in the language itself.
export const LANGUAGES: Record<Locale, { name: string; tag: string; og: string }> = {
  en: { name: "English", tag: "en", og: "en_US" },
  fr: { name: "Français", tag: "fr", og: "fr_FR" },
};

// The cookie the language menu sets, which / then follows (next.config.ts).
export const LANG_COOKIE = "unheard-lang";

export const isLocale = (value: string | undefined | null): value is Locale => (LOCALES as readonly string[]).includes(value ?? "");

/** A page in a language: pathFor("fr", "/privacy") is /fr/privacy, pathFor("en") is /. */
export const pathFor = (locale: Locale, page = "") => (locale === DEFAULT_LOCALE ? page || "/" : `/${locale}${page}`);

/** The page a path shows, without its language: "/fr/privacy" and "/privacy" are "/privacy", "/fr" is "". */
export function pageOf(pathname: string): string {
  const [, first, ...rest] = pathname.split("/");
  const page = isLocale(first) ? rest.join("/") : [first, ...rest].join("/");
  return page ? `/${page}` : "";
}

type Value = string | number;

/**
 * "{name} is coming" with { name: "A Cessna 172" }. Numbers are written the language's way
 * (118, 1 000, 6,5); a placeholder with no value stays as it is.
 */
export function fill(text: string, values: Record<string, Value>, locale: Locale = DEFAULT_LOCALE): string {
  const number = new Intl.NumberFormat(LANGUAGES[locale].tag, { maximumFractionDigits: 2 });
  return text.replace(/\{(\w+)\}/g, (all, key: string) => {
    const value = values[key];
    return value === undefined ? all : typeof value === "number" ? number.format(value) : value;
  });
}

/** A message that depends on a count: "other" always, the language's other plural forms as it needs them. */
export type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

/**
 * The form of `forms` the language's plural rules pick for n, filled with { n } and `values`:
 * plural("fr", 0, { one: "{n} avion", other: "{n} avions" }) is "0 avion".
 */
export function plural(locale: Locale, n: number, forms: Plural, values: Record<string, Value> = {}): string {
  const rule = new Intl.PluralRules(LANGUAGES[locale].tag).select(n);
  return fill(forms[rule] ?? forms.other, { n, ...values }, locale);
}
