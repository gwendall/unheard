// Out on the water: people rarely record there. An answer at sea loses AT_SEA nats against one on
// land and is never dropped, so a recording from a boat is still found, and a spot within SHORE
// metres of land counts as land (the terrain's pixels are 120 m wide, a pier reaches out). On the
// corpora of evals/wherewhen.eval.ts no truth lies at sea and 12 of 130 best answers did (2026-11-04).

/** Metres from ground above 0 within which a spot counts as land. */
export const SHORE = 1000;
/** What an answer at sea loses, in nats: ln 100, about one recording in a hundred made on the water. */
export const AT_SEA = 4.6;

/** South, north, west, east. */
type Box = [number, number, number, number];

/**
 * Land below sea level too wide for SHORE to save: the terrain reads 0 there, as it does at sea. From
 * the towns of GeoNames with no ground above 0 within 10 km, and the depressions on the map. Water
 * inside these boxes counts as land too: nothing there loses more or says more than it did before.
 */
const BELOW_SEA_LEVEL: Box[] = [
  [50.9, 54.9, 2.5, 12], // the Low Countries, north Germany, Lolland
  [36.5, 48.9, 45, 55], // the Caspian depression and its shores
  [44.4, 45.9, 11.8, 13.5], // Venice, the Po delta
  [44.8, 46.6, 28.6, 32], // the Danube delta
  [45.1, 45.9, 37.5, 38.5], // the Kuban delta
  [30.9, 31.7, 29.9, 32.5], // the north of the Nile delta
  [28.5, 30.6, 25, 31], // Qattara, Faiyum
  [29.4, 33, 35.2, 35.8], // the Dead Sea, the Jordan valley
  [10.5, 14.8, 39.5, 43], // Afar
  [33.2, 35, 5.5, 9.5], // the chotts of Algeria and Tunisia
  [42.2, 43.2, 88.2, 90.6], // Turpan
  [32.3, 33.7, -116.4, -115.1], // the Imperial Valley, the Salton Sea
  [35.7, 36.9, -117.3, -116.4], // Death Valley
  [37.84, 38.32, -121.8, -121.34], // the Sacramento delta
  [29.5, 30.3, -90.7, -89.5], // New Orleans
  [-29.9, -27.5, 136.5, 138.5], // Lake Eyre
  [-50.2, -49.3, -69, -67.5], // Laguna del Carbon
];

/** Rings looked through around a spot, metres apart, and the points along them: pixels are 120 m. */
const STEP = 150;
const METRES_PER_DEGREE = 111_195;

/**
 * Whether a spot lies at sea, from the ground's height (lib/terrain.ts reads 0 at sea and where no
 * tile came). Lakes stand at their surface's height and read as land. With no ground above 0 anywhere
 * in the square the terrain says nothing (flat when its tiles failed): nothing is at sea.
 */
export function seaOf(ground: (lat: number, lon: number) => number, area: { lat: number; lon: number; side: number }): (lat: number, lon: number) => boolean {
  const half = area.side / 2;
  const across = METRES_PER_DEGREE * Math.cos((area.lat * Math.PI) / 180);
  let land = false;
  for (let e = -half; e <= half && !land; e += 2000) {
    for (let n = -half; n <= half && !land; n += 2000) land = ground(area.lat + n / METRES_PER_DEGREE, area.lon + e / across) > 0;
  }
  if (!land) return () => false;
  return (lat, lon) => {
    if (ground(lat, lon) > 0 || BELOW_SEA_LEVEL.some(([s, n, w, e]) => lat >= s && lat <= n && lon >= w && lon <= e)) return false;
    const east = METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
    for (let r = STEP; r <= SHORE; r += STEP) {
      const points = Math.ceil((2 * Math.PI * r) / STEP);
      for (let k = 0; k < points; k++) {
        const a = (k / points) * 2 * Math.PI;
        if (ground(lat + (r * Math.cos(a)) / METRES_PER_DEGREE, lon + (r * Math.sin(a)) / east) > 0) return false;
      }
    }
    return true;
  };
}

/**
 * Down, never out: in a list sorted with the prior, the best by the sound alone stays second at
 * worst. Five answers come back and a page shows three: a boat is not sixth because some land around
 * it fits nearly as well.
 */
export function keepBest<T>(sorted: T[], heard: (x: T) => number): void {
  let at = 0;
  sorted.forEach((x, i) => {
    if (heard(x) > heard(sorted[at])) at = i;
  });
  if (at > 1) sorted.splice(1, 0, ...sorted.splice(at, 1));
}
