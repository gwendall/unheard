// Writes the end-to-end fixture: a synthetic recording of the example flyby as Chrome's fake
// microphone will play it (48 kHz WAV), and the polls an aggregator would have answered, timed
// from the WAV's first sample. Run with: pnpm exec tsx scripts/make-e2e-fixture.ts
//
// e2e/fixtures/flyby.wav        what the fake microphone plays, from t = 0
// e2e/fixtures/flyby-polls.json { listener, target, polls: [{ t, poll }] }, t in seconds from t = 0
// e2e/fixtures/voice.wav        a 40 s voice note (48 kHz) for the "somewhere else" page
// e2e/fixtures/elsewhere-polls.json  { centre, polls }: three real adsb.lol polls over Phoenix, 3 s apart
// e2e/fixtures/flyby.mp4, .mov, .webm, .ts, silent.mp4  the flyby under a test picture for the cleaned
//   video, with a phone's date, place and device: made by ffmpeg, skipped when there is none

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
const listener = { lat: 48.8556, lon: 2.2986, elevation: 160 };

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

// The videos: the flyby's sound under a test picture, B-frames on, with what a phone writes.
const path = (name: string) => fileURLToPath(new URL(name, dir));
const picture = (seconds: number) => ["-f", "lavfi", "-i", `testsrc2=size=320x180:rate=15:duration=${seconds}`];
const sound = ["-i", path("flyby.wav"), "-map", "0:v", "-map", "1:a"];
const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-bf", "2", "-threads", "2", "-pix_fmt", "yuv420p"];
const aac = ["-c:a", "aac", "-b:a", "128k"];
const phone = ["-metadata", "creation_time=2026-05-16T14:03:00Z", "-metadata", "com.apple.quicktime.creationdate=2026-05-16T14:03:00+0200", "-metadata", "com.apple.quicktime.location.ISO6709=+48.8556+002.2986+160.000/", "-metadata", "com.apple.quicktime.make=Apple", "-metadata", "com.apple.quicktime.model=iPhone 15 Pro", "-movflags", "+use_metadata_tags"];
const noise = ["-f", "lavfi", "-i", "anoisesrc=d=5:c=pink:r=16000:a=0.05"];
const tagged = ["-metadata", "title=Marked title", "-metadata", "artist=Marked artist", "-metadata", "date=2026-05-16"];
const videos: [string, string[]][] = [
  // A second sound track, as a phone's spatial audio has: it holds the tones too and must not survive.
  ["flyby.mp4", [...picture(DURATION), "-i", path("flyby.wav"), "-i", path("flyby.wav"), "-map", "0:v", "-map", "1:a", "-map", "2:a", ...h264, ...aac, ...phone]],
  ["flyby.mov", [...picture(DURATION), ...sound, ...h264, ...aac, ...phone]],
  ["flyby.webm", [...picture(DURATION), ...sound, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-threads", "2", "-b:v", "300k", "-c:a", "libopus", "-b:a", "96k", "-metadata", "creation_time=2026-05-16T14:03:00Z", "-metadata", "location=+48.8556+002.2986/"]],
  ["flyby.ts", [...picture(DURATION), ...sound, ...h264, ...aac, "-f", "mpegts"]],
  ["silent.mp4", [...picture(5), ...h264, "-metadata", "creation_time=2026-05-16T14:03:00Z"]],
  // For the copy without its tags: no tone under a phone's tags, a picture we cannot write, and sound files with a date and a name.
  ["quiet.mp4", [...picture(5), ...noise, "-map", "0:v", "-map", "1:a", ...h264, ...aac, ...phone]],
  ["old-picture.mp4", [...picture(5), ...noise, "-map", "0:v", "-map", "1:a", "-c:v", "mpeg4", ...aac, ...phone]],
  ["tagged.mp3", [...noise, ...tagged, "-c:a", "libmp3lame", "-b:a", "64k"]],
  ["tagged.m4a", [...noise, ...tagged, ...aac]],
  ["tagged.flac", [...noise, ...tagged, "-c:a", "flac"]],
  ["tagged.ogg", [...noise, ...tagged, "-c:a", "libopus", "-b:a", "48k"]],
  ["tagged.wav", [...noise, ...tagged, "-c:a", "pcm_s16le"]],
];
try {
  for (const [name, args] of videos) execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, path(name)]);
  console.log(`fixture: ${videos.length} videos`);
} catch (err) {
  console.warn(`fixture: no videos, ffmpeg failed or is missing (${String(err).slice(0, 80)})`);
}
