// Counts and their uncertainty, for the scoreboard and the eval delta. Plain functions, no
// imports: Node runs this file directly from scripts/ (type stripping), vitest from the tests.

/** Wilson score interval for k successes out of n, at 95 % by default: [low, high] in 0..1. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

/**
 * "7 / 10, 70 % (40 to 89 %)". Zero out of n reads "0 / 30 (at most 11 %)": what a clean
 * record still allows. Nothing to count reads "none".
 */
export function rate(k: number, n: number): string {
  if (n <= 0) return "none";
  const [lo, hi] = wilson(k, n);
  if (k === 0) return `0 / ${n} (at most ${pct(hi)})`;
  return `${k} / ${n}, ${pct(k / n)} (${Math.round(lo * 100)} to ${pct(hi)})`;
}
