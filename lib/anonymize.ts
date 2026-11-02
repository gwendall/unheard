// What leaves the phone when someone donates a recording: the same scene, nowhere and at no time.
//
// - Every position is taken relative to the listener, who is moved to 0° 0° at sea level.
// - The whole scene turns by a random angle around the vertical: approach paths and runway
//   headings would otherwise give an airport away.
// - The clock moves so the recording starts at 2000-01-01T00:00:00Z.
// - Aircraft lose their ICAO address, flight number and registration, and keep their type.
// - The microphone keeps its audio settings only (getSettings() also carries device ids).
//
// The analysis only sees the geometry relative to the listener, the air and the time between
// polls, so it gives the same answer before and after (lib/anonymize.test.ts checks it). The angle
// and the shifts are drawn here and never stored.

import type { Poll, PolledAircraft } from "./adsb";
import type { Bundle } from "./bundle";
import { fromLocal, toLocal, type Listener, type Vec3 } from "./core/geo";

export const ORIGIN: Listener = { lat: 0, lon: 0, elevation: 0 };
/** 2000-01-01T00:00:00Z, in seconds. */
export const EPOCH = 946_684_800;
const FT = 0.3048;
const AUDIO_SETTINGS = ["sampleRate", "sampleSize", "channelCount", "echoCancellation", "noiseSuppression", "autoGainControl", "latency"];
const RAD = Math.PI / 180;

/** `turn` in degrees, clockwise seen from above (a heading of h becomes h + turn). */
export function anonymize(bundle: Bundle, turn = Math.random() * 360): Bundle {
  const r = bundle.recording;
  const listener = r.listener;
  const cos = Math.cos(turn * RAD);
  const sin = Math.sin(turn * RAD);
  const rotate = (e: number, n: number): [number, number] => [e * cos + n * sin, n * cos - e * sin];
  const shiftMs = (EPOCH - r.start) * 1000;
  const feet = listener.elevation / FT;

  const ids = new Map<string, string>();
  const idOf = (hex: string) => {
    if (!ids.has(hex)) ids.set(hex, `x${String(ids.size + 1).padStart(2, "0")}`);
    return ids.get(hex)!;
  };

  const aircraftOf = (a: PolledAircraft): PolledAircraft => {
    const out: PolledAircraft = { hex: idOf(a.hex) };
    if (a.t !== undefined) out.t = a.t;
    if (a.category !== undefined) out.category = a.category;
    if (a.lat !== undefined && a.lon !== undefined) {
      const [e, n] = toLocal(listener, a.lat, a.lon, 0);
      const [e2, n2] = rotate(e, n);
      const at = fromLocal(ORIGIN, e2, n2);
      out.lat = at.lat;
      out.lon = at.lon;
    }
    // Heights above the listener are what the physics uses: lower everything by the listener's.
    if (typeof a.alt_geom === "number") out.alt_geom = a.alt_geom - feet;
    if (typeof a.alt_baro === "number") out.alt_baro = a.alt_baro - feet;
    else if (a.alt_baro !== undefined) out.alt_baro = a.alt_baro;
    if (a.gs !== undefined) out.gs = a.gs;
    if (a.track !== undefined) out.track = (((a.track + turn) % 360) + 360) % 360;
    if (a.geom_rate !== undefined) out.geom_rate = a.geom_rate;
    if (a.baro_rate !== undefined) out.baro_rate = a.baro_rate;
    if (a.seen_pos !== undefined) out.seen_pos = a.seen_pos;
    return out;
  };

  const polls: Poll[] = r.polls.map((p) => ({ now: p.now + shiftMs, aircraft: p.aircraft.map(aircraftOf) }));
  const wind = r.air.wind;
  const air = { ...r.air, ...(wind ? { wind: [...rotate(wind[0], wind[1]), wind[2]] as Vec3 } : {}) };
  // Addresses that appear only in the answer or the truth still get a stable stand-in.
  const mapped = (hex: string | null) => (hex === null ? null : idOf(hex));

  return {
    version: 1,
    anonymous: true,
    capturedAt: new Date(EPOCH * 1000).toISOString(),
    app: bundle.app,
    recording: { sampleRate: r.sampleRate, start: EPOCH, listener: ORIGIN, air, polls, wav: r.wav },
    ...(bundle.device
      ? {
          device: {
            userAgent: bundle.device.userAgent,
            inputSampleRate: bundle.device.inputSampleRate,
            settings: Object.fromEntries(Object.entries(bundle.device.settings ?? {}).filter(([k]) => AUDIO_SETTINGS.includes(k))),
          },
        }
      : {}),
    ...(bundle.answer ? { answer: { ...bundle.answer, id: mapped(bundle.answer.id) } } : {}),
    ...(bundle.truth ? { truth: { heard: mapped(bundle.truth.heard), note: bundle.truth.note } } : {}),
  };
}
