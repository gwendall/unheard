// Holds every messages/<code>.json to English's: one file for each language lib/locales.ts lists,
// the same keys, the same list lengths, and in each string the same placeholders ({name}), so no
// language loses a name or a number. A count's message ({ one, other }) may have the plural forms
// its language needs, "other" always. Also refuses empty strings and the em and en dashes.
// Runs in `lint` and `build`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES } from "../lib/locales.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "messages");
const read = (code: string): unknown => JSON.parse(readFileSync(join(dir, `${code}.json`), "utf8"));
const english = read("en");
const problems: string[] = [];

const FORMS = ["zero", "one", "two", "few", "many", "other"];
const isPlural = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && "other" in v && Object.keys(v).every((k) => FORMS.includes(k));
const marks = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(([m]) => m).sort().join(" ");

function compareString(where: string, base: string, other: unknown) {
  if (typeof other !== "string") return problems.push(`${where} should be a string`);
  if (base !== "" && other.trim() === "") problems.push(`${where} is empty`);
  if (/[–—]/.test(other)) problems.push(`${where} has an em or en dash`);
  if (marks(base) !== marks(other)) problems.push(`${where} has "${marks(other)}", English has "${marks(base)}"`);
}

function compare(code: string, path: string, base: unknown, other: unknown) {
  const where = `${code}: ${path || "(root)"}`;
  if (typeof base === "string") return compareString(where, base, other);
  if (typeof base === "number") {
    if (typeof other !== "number") problems.push(`${where} should be a number`);
    return;
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(other) || other.length !== base.length) return problems.push(`${where} should list ${base.length}`);
    return base.forEach((item, i) => compare(code, `${path}[${i}]`, item, other[i]));
  }
  if (isPlural(base)) {
    if (!isPlural(other)) return problems.push(`${where} should be a count's forms (${FORMS.join(", ")}), "other" always`);
    // Each form against English's same form, or its "other" when English has no such form.
    for (const [form, text] of Object.entries(other)) compareString(`${where}.${form}`, base[form] ?? base.other, text);
    return;
  }
  if (typeof other !== "object" || other === null || Array.isArray(other)) return problems.push(`${where} should be an object`);
  const b = base as Record<string, unknown>;
  const o = other as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!(key in o)) problems.push(`${where}.${key} is missing`);
    else compare(code, path ? `${path}.${key}` : key, b[key], o[key]);
  }
  for (const key of Object.keys(o)) if (!(key in b)) problems.push(`${where}.${key} is not in English`);
}

const files = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.replace(/\.json$/, ""));
for (const code of LOCALES) if (!files.includes(code)) problems.push(`messages/${code}.json is missing (lib/locales.ts lists ${code})`);
for (const code of files) {
  if (!(LOCALES as readonly string[]).includes(code)) problems.push(`messages/${code}.json is not in LOCALES (lib/locales.ts)`);
  else compare(code, "", english, read(code));
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`check-messages: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`check-messages: ${files.length} languages match English`);
