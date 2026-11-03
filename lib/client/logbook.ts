// The planes someone found, kept in this browser only (localStorage), never sent anywhere: the
// list that makes a second listen worth it. Read with useLogbook(); written once per result.

export type Entry = {
  /** When the result was given, ms since 1970. */
  at: number;
  hex: string;
  /** The name shown on the verdict: a flight, a model or a callsign. */
  title: string;
  kind: "flight" | "model" | "callsign";
  sure: boolean;
  /** Metres from the listener at its closest, and above them. */
  range: number;
  height: number;
  route: { from: string; to: string } | null;
};

export const KEY = "unheard.logbook.v1";
const MAX = 200;
/** The same aircraft found again within this time is the same flyby, not a new entry. */
const SAME_FLYBY_MS = 15 * 60_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function valid(e: unknown): e is Entry {
  const x = e as Entry;
  return !!x && typeof x.at === "number" && typeof x.hex === "string" && typeof x.title === "string" && typeof x.range === "number" && typeof x.height === "number";
}

export function readLog(store: Store): Entry[] {
  try {
    const raw = JSON.parse(store.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(valid).sort((a, b) => b.at - a.at) : [];
  } catch {
    return [];
  }
}

/** Adds a find, newest first; a second result for the same flyby replaces the first. */
export function addToLog(store: Store, entry: Entry): Entry[] {
  const kept = readLog(store).filter((e) => !(e.hex === entry.hex && Math.abs(e.at - entry.at) < SAME_FLYBY_MS));
  const next = [entry, ...kept].slice(0, MAX);
  try {
    store.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or refused (private mode): the logbook is a nicety, the result still shows.
  }
  return next;
}

export function clearLog(store: Store): void {
  store.removeItem(KEY);
}

/** What the logbook adds up to: how many finds, how many different aircraft, the closest one. */
export function summary(log: Entry[]): { finds: number; aircraft: number; closest: Entry | null } {
  return {
    finds: log.length,
    aircraft: new Set(log.map((e) => e.hex)).size,
    closest: log.reduce<Entry | null>((c, e) => (!c || e.range < c.range ? e : c), null),
  };
}
