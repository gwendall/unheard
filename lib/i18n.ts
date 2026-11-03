import type en from "@/messages/en.json";
import { DEFAULT_LOCALE, LANGUAGES, LOCALES, pathFor, type Locale } from "@/lib/locales";
import { typeset } from "@/lib/typography";

export * from "@/lib/locales";

// Each language speaks from messages/<code>.json, one for each code lib/locales.ts lists, which
// scripts/check-messages.mjs holds to English's keys, list lengths and placeholders. Loaded on the
// server; the [lang] layout hands them to the page's client components (components/I18n.tsx).
export type Messages = typeof en;

export const messages = (locale: Locale): Promise<Messages> =>
  import(`../messages/${locale}.json`).then((m: { default: Messages }) => typeset(locale, m.default));

/** The same page in every language, for the alternates of its metadata. */
export const alternates = (locale: Locale, page = "") => ({
  canonical: pathFor(locale, page),
  languages: { ...Object.fromEntries(LOCALES.map((code) => [LANGUAGES[code].tag, pathFor(code, page)])), "x-default": pathFor(DEFAULT_LOCALE, page) },
});
