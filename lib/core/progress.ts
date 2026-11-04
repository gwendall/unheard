// How far a long job has got and how long it has left, for a progress bar a person can trust. The
// stages report what they know; this holds the bar steady and turns it into a time.

/** Seconds from any origin: the worker's own clock, or the one a test steps. */
export type Clock = () => number;

export type Estimate = {
  /** How far the job has got, 0 to 1: it never goes back. */
  fraction: number;
  /** Seconds left, once they can be told: see `estimator`. Null until then, and whenever it would not hold. */
  secondsLeft: number | null;
};

/** How far into the last stage, and how long in it, before its pace says anything. */
const FIRST_SHARE = 0.15;
const FIRST_SECONDS = 1;
/** What the last stage's pace is stretched by, and what may still come after it, for a time that is not beaten. */
const MARGIN = 1.25;
const AFTER_SECONDS = 3;

/**
 * Feed it the job's fraction as often as it moves: the bar never goes back, even when a stage's
 * guess was short (the rounds of a cleaning are only known as they come).
 *
 * The stages' shares make a bar, not a clock: on a real hour a share ran from 2 to 6 minutes as the
 * first stage went, and 5 s with 60 s to go near the end. So no time is told before the last stage,
 * which starts at `lastStage` of the job, whatever the shares are, and then only from that stage's
 * own pace. A time told never rises: past one, none is told until the pace is back under it. Nor
 * does it hold at the end of the stage, when what is left is not counted.
 */
export function estimator(clock: Clock, lastStage = 0): (fraction: number) => Estimate {
  let shown = 0;
  let began: number | null = null;
  let told = Infinity;
  return (fraction) => {
    shown = Math.min(1, Math.max(shown, fraction));
    const now = clock();
    if (shown >= lastStage) began ??= now;
    if (shown >= 1 || began === null) return { fraction: shown, secondsLeft: null };
    const share = (shown - lastStage) / (1 - lastStage);
    const elapsed = now - began;
    if (share < FIRST_SHARE || elapsed < FIRST_SECONDS) return { fraction: shown, secondsLeft: null };
    const left = (MARGIN * elapsed * (1 - share)) / share + AFTER_SECONDS;
    if (left > told) return { fraction: shown, secondsLeft: null };
    told = left;
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
