// Polls the aircraft around the listener: every 2 s while the page records, slower while it watches. Only a coarse
// location (0.1 degree, about 10 km) leaves the phone: the precise one stays here.

import type { Poll } from "../adsb";

export const coarse = (x: number) => Math.round(x * 10) / 10;

export class Sky {
  readonly polls: Poll[] = [];
  failures = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly lat: number,
    private readonly lon: number,
    private readonly onPoll: (poll: Poll, sky: Sky) => void,
    private every = 2000,
  ) {}

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.every);
  }

  /** Polls every `ms` from now on: slower while only watching, every 2 s while recording. */
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
      const res = await fetch(`/api/aircraft?lat=${coarse(this.lat)}&lon=${coarse(this.lon)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const poll = (await res.json()) as Poll;
      if (!this.timer) return;
      this.polls.push(poll);
      this.onPoll(poll, this);
    } catch {
      this.failures++;
    }
  }
}
