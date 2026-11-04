// When a place is named (namesAPlace in lib/client/where.ts): the files the where page's numbers are
// measured on, each searched at 100 km with the hour known, and the same searches in hours away from
// the recording, where the truth cannot be and anything named is wrong. `where.result.honest`,
// `fewText`, `thinText`, `wrongText` and `proof.whereValue` quote this report.
//
//   pnpm eval evals/wherewhen-named                 the files
//   NULLS=1 pnpm eval evals/wherewhen-named         and the hours and days away from them
//   KINDS="3 recordings,colsto 4" pnpm eval evals/wherewhen-named
//
// Needs evals/.cache/livermore, evals/.cache/colsto and the days indexed, like evals/wherewhen. Slow
// (about an hour of CPU for the files, about eight with the nulls); never in CI. Reported by distance only:
// the microphone positions stay in the cache.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeWav } from "../lib/bundle";
import { namesAPlace, passesOf } from "../lib/client/where";
import { flybys } from "../lib/core/flyby";
import { offsetOf } from "../lib/core/locate";
import { findSegments, rankOf, whereWhen, type Segment, type WhereWhen } from "../lib/core/wherewhen";
import { groundAround, historyAround } from "./lib/history";
import { NAMED_FILES } from "./lib/named-files";
import { livermoreScenarios } from "./lib/real";

const SIDE = 100_000;
const BAY = { lat: 37.75, lon: -122.2 };
const LONG_ISLAND = { lat: 40.8, lon: -73.7 };
/** Right: within this of the truth, in metres and seconds. */
const RIGHT_M = 1000;
const RIGHT_S = 30;
/** The hours searched where the truth cannot be, in hours from the recording's. */
const AWAY = [-12, -8, -4, -2, 2, 4];
/** The days searched where the truth cannot be, in days from the recording's. */
const AWAY_DAYS = [-2, 2];
const KINDS = process.env.KINDS?.split(",");

type File = { name: string; kind: string; segments: Segment[]; searched: [number, number][]; truth: { lat: number; lon: number; start: number }; duration: number; at: { lat: number; lon: number } };

let scenarios: ReturnType<typeof livermoreScenarios> | null = null;
const livermore = () => (scenarios ??= livermoreScenarios());
const COLSTO = new URL("./.cache/colsto/", import.meta.url);
let colsto: { samples: Float32Array; rate: number; truth: { lat: number; lon: number; start: number } } | null = null;
const colstoSound = () => {
  if (colsto) return colsto;
  const wav = decodeWav(new Uint8Array(readFileSync(new URL("audio-8k.wav", COLSTO))));
  colsto = { samples: wav.samples, rate: wav.sampleRate, truth: JSON.parse(readFileSync(new URL("truth.json", COLSTO), "utf8")) };
  return colsto;
};

/** `colsto`, `colsto@<offset s>+<length s>`, `lvk-...`, `pair:<id>+<id>...`: recordings of one site read as one file with gaps. */
function fileOf(name: string): File {
  const kind = kindOf(name);
  if (name.startsWith("colsto")) {
    const c = colstoSound();
    const m = /@(\d+)\+(\d+)/.exec(name);
    const [off, len] = m ? [Number(m[1]), Number(m[2])] : [0, c.samples.length / c.rate];
    const samples = c.samples.subarray(Math.round(off * c.rate), Math.round((off + len) * c.rate));
    return { name, kind, ...findSegments(samples, c.rate), truth: { ...c.truth, start: c.truth.start + off }, duration: samples.length / c.rate, at: LONG_ISLAND };
  }
  const ids = name.startsWith("pair:") ? name.slice(5).split("+") : [name];
  const parts = ids.map((id) => livermore().find((s) => s.id === id)!.recording);
  const segments: Segment[] = [];
  const searched: [number, number][] = [];
  let end = 0;
  for (const r of parts) {
    const off = r.start - parts[0].start;
    segments.push(...findSegments(r.samples, r.sampleRate).segments.map((g) => ({ ...g, offset: g.offset + off })));
    end = off + r.samples.length / r.sampleRate;
    searched.push([off, end]);
  }
  return { name, kind, segments, searched, truth: { lat: parts[0].listener.lat, lon: parts[0].listener.lon, start: parts[0].start }, duration: end, at: BAY };
}

function kindOf(name: string): string {
  if (name.startsWith("colsto")) {
    const m = /\+(\d+)/.exec(name);
    return `colsto ${m ? Math.round(Number(m[1]) / 60) : 60} min`;
  }
  if (!name.startsWith("pair:")) return "one recording";
  const n = name.split("+").length;
  return n === 2 ? "two recordings" : n >= 11 ? "11 or more recordings" : `${n} recordings`;
}

const dayOf = (utc: number) => new Date(utc * 1000).toISOString().slice(0, 10);
const daysFrom = (from: number, to: number) => {
  const out: string[] = [];
  for (let d = Math.floor(from / 86_400); d <= Math.floor(to / 86_400); d++) out.push(dayOf(d * 86_400));
  return out;
};

async function searchOf(file: File, from: number, to = from + 3600): Promise<{ ww: WhereWhen; passes: number; named: boolean }> {
  const heard = flybys(file.segments);
  const low = heard.filter((h) => h.f0 <= 400);
  const passes = passesOf((low.length ? low : heard).map((h) => h.closest));
  const { flights } = await historyAround(daysFrom(from, to + file.duration), file.at.lat, file.at.lon, SIDE);
  const ground = await groundAround(file.at.lat, file.at.lon, SIDE);
  const ww = await whereWhen(file.segments, flights, { window: [from, to], area: { ...file.at, side: SIDE }, ground, air: { groundTempC: 15 }, searched: file.searched });
  const best = ww.answers[0];
  return { ww, passes, named: !!best && namesAPlace(passes, best.wellHeard, rankOf(best), ww.searched) };
}

const isRight = (file: File, ww: WhereWhen) => {
  const best = ww.answers[0];
  return !!best && Math.hypot(...offsetOf(file.truth, best.lat, best.lon)) <= RIGHT_M && Math.abs(best.start - file.truth.start) <= RIGHT_S;
};

it("when a place is named", async () => {
  if (!existsSync(new URL("audio-8k.wav", COLSTO)) || !livermore().length) return console.warn("no colsto or Livermore in the cache: skipped");
  const rows = new Map<string, { n: number; rightBefore: number; wrongBefore: number; right: number; wrong: number; refused: number; none: number; nulls: number; nullsNamed: number; nullsFlag: number }>();
  for (const name of NAMED_FILES) {
    if (KINDS && !KINDS.some((k) => kindOf(name).includes(k))) continue;
    const file = fileOf(name);
    const row = rows.get(file.kind) ?? { n: 0, rightBefore: 0, wrongBefore: 0, right: 0, wrong: 0, refused: 0, none: 0, nulls: 0, nullsNamed: 0, nullsFlag: 0 };
    rows.set(file.kind, row);
    const hour = Math.floor(file.truth.start / 3600) * 3600;
    const { ww, named } = await searchOf(file, hour);
    row.n++;
    if (!ww.answers.length) row.none++;
    else {
      if (isRight(file, ww)) row.rightBefore++;
      else row.wrongBefore++;
      if (!named) row.refused++;
      else if (isRight(file, ww)) row.right++;
      else row.wrong++;
    }
    if (process.env.NULLS) {
      const day = Math.floor(file.truth.start / 86_400) * 86_400;
      const away = [
        ...AWAY.map((h) => [hour + h * 3600, hour + (h + 1) * 3600]),
        ...AWAY_DAYS.map((d) => [day + d * 86_400, day + (d + 1) * 86_400 + file.duration]),
      ];
      for (const [from, to] of away) {
        const search = await searchOf(file, from, to);
        row.nulls++;
        if (search.named) row.nullsNamed++;
        if (search.ww.confident) row.nullsFlag++;
      }
    }
  }
  const wrong = [...rows.values()].reduce((a, r) => a + r.wrong, 0);
  const lines = ["# When a place is named", "", "100 km, hour known, right within 1 km and 30 s.", "", "| file | files | before: right, wrong | the rule: right, wrong, refused | no answer | hours and days away: named of searched, flag up |", "|---|---|---|---|---|---|"];
  for (const [kind, r] of rows) lines.push(`| ${kind} | ${r.n} | ${r.rightBefore}, ${r.wrongBefore} | ${r.right}, ${r.wrong}, ${r.refused} | ${r.none} | ${r.nullsNamed} of ${r.nulls}, ${r.nullsFlag} |`);
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./reports/wherewhen-named.md", import.meta.url), lines.join("\n") + "\n");
  // Only the files' own wrong answers fail this: the hours and days away are a measure to read, not a promise
  // (a file of several recordings can name a place on one of them, see "When a place is named" in docs/STATUS.md).
  expect(wrong).toBe(0);
}, 12 * 3_600_000);
