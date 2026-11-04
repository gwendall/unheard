// How far a long job has got and how long it has left, for a progress bar a person can trust. The
// stages report what they know; this holds the bar steady and turns it into a time.

/** Seconds from any origin: the worker's own clock, or the one a test steps. */
export type Clock = () => number;

export type Estimate = {
  /** How far the job has got, 0 to 1: it never goes back. */
  fraction: number;
  /** Seconds left at the pace so far; null while there is too little to go on. */
  secondsLeft: number | null;
};

/** No time left to show before this much of the job, or this many seconds, went by. */
const FIRST_SHARE = 0.02;
const FIRST_SECONDS = 1;
/** How fast the time left follows the pace, seconds: slow enough not to jump about between steps. */
const SETTLE = 4;

/**
 * Feed it the job's fraction as often as it moves: the bar never goes back, even when a stage's
 * guess was short (the rounds of a cleaning are only known as they come), and the time left is
 * the pace so far, settling over a few seconds.
 */
export function estimator(clock: Clock): (fraction: number) => Estimate {
  const start = clock();
  let shown = 0;
  let left: number | null = null;
  let last = start;
  return (fraction) => {
    shown = Math.min(1, Math.max(shown, fraction));
    if (shown >= 1) return { fraction: 1, secondsLeft: 0 };
    const now = clock();
    const elapsed = now - start;
    if (shown < FIRST_SHARE || elapsed < FIRST_SECONDS) return { fraction: shown, secondsLeft: null };
    const pace = (elapsed * (1 - shown)) / shown;
    left = left === null ? pace : left + (1 - Math.exp(-(now - last) / SETTLE)) * (pace - left);
    last = now;
    return { fraction: shown, secondsLeft: left };
  };
}

/** A job's stages in order, each with its share of the whole: the job's fraction from a stage and how far into it. */
export function stagesOf<S extends string>(shares: readonly (readonly [S, number])[]): (stage: S, share: number) => number {
  const sum = shares.reduce((a, [, s]) => a + s, 0);
  const before = new Map<S, [number, number]>();
  let done = 0;
  for (const [stage, s] of shares) {
    before.set(stage, [done / sum, s / sum]);
    done += s;
  }
  return (stage, share) => {
    const [from, size] = before.get(stage) ?? [0, 0];
    return from + size * Math.min(1, Math.max(0, share));
  };
}
