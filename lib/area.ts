// One area of the sky, agreed between the page and the API route. adsb.lol allows about one
// request every 2 s per address, and every listener reaches it from the site's address: all the
// listeners of a square of the grid ask for the same URL and share one cached answer. The circle
// asked upstream covers REACH from anywhere in the square; the page keeps what is within REACH
// of the listener, the same sky wherever in the square they stand.

/** The grid, degrees: a square about 28 km from south to north, narrower away from the equator. */
export const GRID = 0.25;

/** How far the page looks around the listener, metres: twice what the matcher can hear (15 km). */
export const REACH = 30_000;

/** From a listener to the point of their square, at worst: half its diagonal at the equator, metres. */
const HALF_DIAGONAL = (GRID / 2) * 111_195 * Math.SQRT2;

/** The circle asked upstream, nautical miles. */
export const RADIUS_NM = Math.ceil((REACH + HALF_DIAGONAL) / 1852);

/** One upstream request per area at most this often, seconds, and how long the CDN keeps its answer. */
export const FRESH_FOR = 2;

/** How old an answer may still be served when upstream refuses, seconds. Its `now` stays true. */
export const STALE_FOR = 60;

export const snap = (x: number) => Math.round(x / GRID) * GRID;

/** The one address of a listener's area, the only form of a position /api/aircraft answers. */
export const areaQuery = (lat: number, lon: number) => `?lat=${snap(lat)}&lon=${snap(lon)}`;
