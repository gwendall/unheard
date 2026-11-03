"use client";

import { createContext, useContext } from "react";
import { dict, DEFAULT_LANG, type Dict, type Lang } from "./index";

// The page's language, set once by the [lang] layout, for the client components below it.
const LangContext = createContext<Lang>(DEFAULT_LANG);

export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return <LangContext value={lang}>{children}</LangContext>;
}

export const useLang = (): Lang => useContext(LangContext);
export const useT = (): Dict => dict(useContext(LangContext));
