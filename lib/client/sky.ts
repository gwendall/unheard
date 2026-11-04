// Polls the aircraft around the listener: every 3 s while the page records, slower while it watches. Only the square
// of the grid around the listener (lib/area.ts) leaves the phone here: the precise location stays, and cuts the
// shared answer down to the planes around them.

import { REACH, areaQuery } from "../area";
import type { Poll } from "../adsb";
import { toLocal } from "../core/geo";

/**
 * While recording. Longer than the 2 s the answer of an area is cached for, with room for the
 * time it takes to arrive: every 2 s, a listener alone in an area would be served the same
 * answer every other time, a new position only every 4 s. Every 3 s, each poll is a new one.
 */
export const RECORD_EVERY = 3000;

/** The sky within REACH of a point, from the poll of its whole area. */
export async function pollAround(lat: number, lon: number): Promise<Poll> {
  const res = await fetch(`/api/aircraft${areaQuery(lat, lon)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const poll = (await res.json()) as Poll;
  const here = { lat, lon, elevation: 0 };
  return {
    now: poll.now,
    aircraft: poll.aircraft.filter((a) => {
      const [e, n] = toLocal(here, a.lat!, a.lon!, 0);
      return Math.hypot(e, n) < REACH;
    }),
  };
}

export class Sky {
  readonly polls: Poll[] = [];
  failures = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly lat: number,
    private readonly lon: number,
    private readonly onPoll: (poll: Poll, sky: Sky) => void,
    private every = RECORD_EVERY,
  ) {}

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.every);
  }

  /** Polls every `ms` from now on: slower while only watching, RECORD_EVERY while recording. */
  pace(ms: number) {
    if (ms === this.every) return;
    this.every = ms;
    if (!this.timer) return;
    clearInterval(this.timer);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.every);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get latest(): Poll | null {
    return this.polls[this.polls.length - 1] ?? null;
  }

  private async tick() {
    try {
      const poll = await pollAround(this.lat, this.lon);
      if (!this.timer) return;
      this.polls.push(poll);
      this.onPoll(poll, this);
    } catch {
      this.failures++;
    }
  }
}
