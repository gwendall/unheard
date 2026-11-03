// Writes the end-to-end fixture: a synthetic recording of the example flyby as Chrome's fake
// microphone will play it (48 kHz WAV), and the polls an aggregator would have answered, timed
// from the WAV's first sample. Run with: pnpm exec tsx scripts/make-e2e-fixture.ts
//
// e2e/fixtures/flyby.wav        what the fake microphone plays, from t = 0
// e2e/fixtures/flyby-polls.json { listener, target, polls: [{ t, poll }] }, t in seconds from t = 0
// e2e/fixtures/voice.wav        a 40 s voice note (48 kHz) for the "somewhere else" page
// e2e/fixtures/elsewhere-polls.json  { centre, polls }: three real adsb.lol polls over Phoenix, 3 s apart

import { mkdirSync, writeFileSync } from "node:fs";
import { STANDARD_AIR } from "../lib/core/doppler";
import { synthesize, flybyFixes } from "../lib/core/synth";
import { buildTrack } from "../lib/core/track";
import { encodeWav } from "../lib/bundle";
import { fabricatePolls } from "../lib/client/fabricate";
import { exampleActors, EXAMPLE_TARGET } from "../lib/client/example";
import { recordedSkies, voiceLike } from "../evals/lib/elsewhere";
import { rng } from "../evals/lib/sim";

const T0 = 1_800_000_000;
const DURATION = 85;
const RATE = 48_000;
const listener = { lat: 48.7731, lon: 2.1186, elevation: 160 };

const actors = exampleActors(T0, listener.elevation);
const target = actors.find((a) => a.meta.hex === EXAMPLE_TARGET)!;
const track = buildTrack(flybyFixes(listener, target.flyby, T0 - 30, T0 + DURATION + 4, 0.5), listener)!;
const samples = synthesize({
  start: T0,
  duration: DURATION,
  sampleRate: RATE,
  air: STANDARD_AIR,
  sources: [{ track, f0: 92, level: 0.15 }],
  noise: 1,
  rumble: 1,
  hum: [{ freq: 50, level: 0.4 }],
  seed: 7,
});

const polls = fabricatePolls(listener, actors, T0 - 10, T0 + DURATION, 1).map((poll) => ({ t: poll.now / 1000 - T0, poll }));

const dir = new URL("../e2e/fixtures/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("flyby.wav", dir), encodeWav(samples, RATE));
writeFileSync(new URL("flyby-polls.json", dir), JSON.stringify({ listener, target: EXAMPLE_TARGET, callsign: target.meta.callsign, polls }));
console.log(`fixture: ${DURATION} s at ${RATE} Hz, ${polls.length} polls`);

// The same sky as the first recorded scene of evals/somewhere-else (adsb.lol data, ODbL).
const sky = recordedSkies(1)[0];
writeFileSync(new URL("voice.wav", dir), encodeWav(voiceLike(rng(5), 40, RATE, 45), RATE));
writeFileSync(new URL("elsewhere-polls.json", dir), JSON.stringify({ centre: sky.centre, polls: sky.live }));
console.log(`fixture: a 40 s voice note, ${sky.live.length} polls over ${sky.name}`);
