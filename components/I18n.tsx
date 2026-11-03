"use client";

import { createContext, Fragment, useContext, useMemo, type ReactNode } from "react";
import { formatFor, type Format } from "@/lib/client/format";
import { fill, plural, type Locale, type Plural } from "@/lib/locales";
import type { Messages } from "@/lib/i18n";

// The page's language and its messages, handed over once by the [lang] layout (lib/i18n.ts loads
// them on the server) to the client components below it.

type Values = Record<string, string | number>;

export type I18n = {
  locale: Locale;
  m: Messages;
  /** Distances, heights, speeds and times the language's way. */
  f: Format;
  fill: (text: string, values: Values) => string;
  plural: (n: number, forms: Plural, values?: Values) => string;
};

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Messages; children: ReactNode }) {
  const value = useMemo<I18n>(
    () => ({
      locale,
      m: messages,
      f: formatFor(locale),
      fill: (text, values) => fill(text, values, locale),
      plural: (n, forms, values) => plural(locale, n, forms, values),
    }),
    [locale, messages],
  );
  return <Ctx value={value}>{children}</Ctx>;
}

export function useI18n(): I18n {
  const value = useContext(Ctx);
  if (!value) throw new Error("useI18n() needs the I18nProvider of app/[lang]/layout.tsx above it");
  return value;
}

/** A message with elements in it: <Rich text="Donation {id}." parts={{ id: <code>…</code> }} />. */
export function Rich({ text, parts }: { text: string; parts: Record<string, ReactNode> }) {
  return text.split(/(\{\w+\})/).map((piece, i) => {
    const key = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={i}>{key && key in parts ? parts[key] : piece}</Fragment>;
  });
}
