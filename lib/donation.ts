// A donated recording: an anonymised capture bundle (lib/anonymize.ts) with a human's answer.
// The page checks it before sending, and scripts/fetch-donations.ts checks every one it pulls:
// what fails here never reaches the dataset.

import { EPOCH, ORIGIN } from "./anonymize";
import { decodeWav, fromBase64, type Bundle } from "./bundle";
import { ANALYSIS_RATE } from "./core/pipeline";

/** Where donations go in the private Blob store (a random suffix is added on upload). */
export const DONATION_PATH = "donations/v1/recording.json";
export const DONATION_PATTERN = /^donations\/v1\/recording(-[A-Za-z0-9]+)?\.json$/;
/** Five minutes at 8 kHz in base64 is 6.4 MB, plus the polls. */
export const MAX_DONATION_BYTES = 12 * 1024 * 1024;
export const MIN_SECONDS = 20;
export const MAX_SECONDS = 310;
const ID = /^x\d{2,}$/;
const AIRCRAFT_KEYS = new Set(["hex", "t", "category", "lat", "lon", "alt_geom", "alt_baro", "gs", "track", "geom_rate", "baro_rate", "seen_pos"]);

/** Problems with a donation, empty when it may enter the dataset. */
export function checkDonation(value: unknown): string[] {
  const out: string[] = [];
  const b = value as Bundle;
  if (!b || typeof b !== "object") return ["not an object"];
  if (b.version !== 1) out.push("version must be 1");
  if (b.anonymous !== true) out.push("not anonymised");
  const r = b.recording;
  if (!r || typeof r !== "object") return [...out, "no recording"];
  if (r.listener?.lat !== ORIGIN.lat || r.listener?.lon !== ORIGIN.lon || r.listener?.elevation !== ORIGIN.elevation) out.push("listener is not at the origin");
  if (r.start !== EPOCH) out.push("clock not moved to the epoch");
  if (r.sampleRate !== ANALYSIS_RATE) out.push(`sample rate must be ${ANALYSIS_RATE}`);
  if (typeof r.air?.groundTempC !== "number" || Math.abs(r.air.groundTempC) > 60) out.push("air temperature missing or implausible");
  try {
    const wav = decodeWav(fromBase64(r.wav));
    const seconds = wav.samples.length / wav.sampleRate;
    if (wav.sampleRate !== r.sampleRate) out.push("WAV rate differs from the recording's");
    if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) out.push(`duration ${seconds.toFixed(0)} s outside ${MIN_SECONDS} to ${MAX_SECONDS} s`);
  } catch {
    out.push("WAV does not decode");
  }
  if (!Array.isArray(r.polls) || r.polls.length === 0 || r.polls.length > 1000) out.push("polls missing or too many");
  else {
    for (const p of r.polls) {
      if (typeof p.now !== "number" || Math.abs(p.now / 1000 - EPOCH) > 3600) {
        out.push("a poll's time is not near the epoch");
        break;
      }
      if (!Array.isArray(p.aircraft) || p.aircraft.length > 500) {
        out.push("a poll has no aircraft list or too many");
        break;
      }
      const bad = p.aircraft.find((a) => !ID.test(a.hex) || Object.keys(a).some((k) => !AIRCRAFT_KEYS.has(k)) || (a.lat !== undefined && Math.abs(a.lat) > 1) || (a.lon !== undefined && Math.abs(a.lon) > 1));
      if (bad) {
        out.push(`aircraft ${String(bad.hex).slice(0, 8)} is not anonymised`);
        break;
      }
    }
  }
  const t = b.truth;
  if (t !== undefined) {
    if (t.heard !== null && !(typeof t.heard === "string" && ID.test(t.heard))) out.push("truth names no anonymised aircraft");
    if (typeof t.note !== "string" || t.note.length > 500) out.push("truth note missing or longer than 500 characters");
  }
  if (b.answer && b.answer.id !== null && !ID.test(b.answer.id)) out.push("answer names no anonymised aircraft");
  return out;
}
