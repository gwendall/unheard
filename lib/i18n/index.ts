import { en, type Dict } from "./en";
import { fr } from "./fr";
import type { Lang } from "./lang";

export { DEFAULT_LANG, isLang, LANGS, locale, negotiate, type Lang } from "./lang";
export type { Dict } from "./en";

const DICTS: Record<Lang, Dict> = { en, fr };
export const dict = (lang: Lang): Dict => DICTS[lang];
