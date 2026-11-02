// Night to indigo to amber to near white: faint evidence stays dark, a real line glows.
const STOPS: [number, number, number, number][] = [
  [0, 5, 7, 13],
  [0.35, 30, 40, 92],
  [0.65, 150, 110, 70],
  [0.85, 255, 181, 71],
  [1, 255, 240, 214],
];

export function colorOf(v: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, v));
  for (let i = 1; i < STOPS.length; i++) {
    const [b, ...hi] = STOPS[i];
    const [a, ...lo] = STOPS[i - 1];
    if (x <= b) {
      const f = (x - a) / (b - a);
      return [lo[0] + f * (hi[0] - lo[0]), lo[1] + f * (hi[1] - lo[1]), lo[2] + f * (hi[2] - lo[2])];
    }
  }
  return [255, 240, 214];
}
