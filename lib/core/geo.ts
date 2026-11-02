// Local east-north-up coordinates around the listener, in metres. A flat tangent plane with the
// Earth's curvature folded into "up" is accurate to well under a metre within the ~30 km we use.

export type Vec3 = [number, number, number];

export type Listener = {
  lat: number;
  lon: number;
  /** Height of the microphone above mean sea level, in metres. */
  elevation: number;
};

const R = 6_371_008.8;
const RAD = Math.PI / 180;

export function toLocal(listener: Listener, lat: number, lon: number, altitude: number): Vec3 {
  const e = (lon - listener.lon) * RAD * Math.cos(listener.lat * RAD) * R;
  const n = (lat - listener.lat) * RAD * R;
  const u = altitude - listener.elevation - (e * e + n * n) / (2 * R);
  return [e, n, u];
}

export function fromLocal(listener: Listener, e: number, n: number): { lat: number; lon: number } {
  return {
    lat: listener.lat + n / R / RAD,
    lon: listener.lon + e / (R * Math.cos(listener.lat * RAD)) / RAD,
  };
}

export const norm = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
