"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AircraftMeta, Poll } from "@/lib/adsb";
import { Capture, openMicrophone, resample } from "@/lib/audio";
import { decodeWav, encodeWav } from "@/lib/bundle";
import type { Listener } from "@/lib/core/geo";
import { STRONG } from "@/lib/core/match";
import { analyze, ANALYSIS_RATE, type Analysis, type Recording } from "@/lib/core/pipeline";
import { fit, loudness, parseCoords, PLACES, planScene, type PlaceId, type Scene } from "@/lib/client/elsewhere";
import { identityOf, spoken } from "@/lib/client/names";
import { revealed, speedFor } from "@/lib/client/reveal";
import { pollAround } from "@/lib/client/sky";
import type { Messages } from "@/lib/i18n";
import { useI18n } from "./I18n";
import { Spectrum } from "./Spectrum";
import { useIdentities } from "./SkyList";
import { Waterfall } from "./Waterfall";

// Somewhere else: a recording given the sky of another place (lib/client/elsewhere.ts), then read
// back by the same analyze() as every recording, from the downloaded file itself.

/** The longest part of a recording used, and the shortest that carries a curve, seconds. */
const MAX_SECONDS = 120;
const MIN_SECONDS = 10;
/** Polls of the place: three, 3 s apart. adsb.lol allows about one request every 2 s. */
const POLLS = 3;
const POLL_EVERY = 3000;
/** Cities tried at most for "anywhere, at random", one poll each until one has a plane low enough. */
const TRIES = 4;
const IDS = Object.keys(PLACES) as PlaceId[];

type Choice = { kind: "city"; id: PlaceId } | { kind: "random" } | { kind: "coords" };
type Audio = { samples: Float32Array; rate: number; name: string | null; trimmed: boolean };
type Place = { lat: number; lon: number; name: string };
type Code = keyof Messages["elsewhere"]["errors"];
type Step = { kind: "searching"; place: string } | { kind: "polls"; place: string; i: number } | { kind: "plant" } | { kind: "check" };
type Done = { scene: Scene; place: Place; analysis: Analysis; rec: Recording; wav: string; file: string; underVoice: number };
type Phase =
  | { kind: "idle" }
  | { kind: "recording"; seconds: number }
  | { kind: "working"; step: Step }
  | { kind: "done"; done: Done }
  | { kind: "error"; code: Code; place?: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function weatherOf(lat: number, lon: number): Promise<{ elevation: number | null; temperatureC: number | null }> {
  try {
    return await (await fetch(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`)).json();
  } catch {
    return { elevation: null, temperatureC: null };
  }
}

/** Mono samples of an audio file, decoded in the browser at 48 kHz. */
async function decodeFile(file: File): Promise<{ samples: Float32Array; rate: number }> {
  const ctx = new OfflineAudioContext(1, 1, 48_000);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) samples[i] += data[i] / buffer.numberOfChannels;
  }
  return { samples, rate: buffer.sampleRate };
}

function trim(samples: Float32Array, rate: number, name: string | null): Audio {
  const max = MAX_SECONDS * rate;
  return { samples: samples.length > max ? samples.slice(0, max) : samples, rate, name, trimmed: samples.length > max };
}

export function Elsewhere() {
  const { m, fill, locale } = useI18n();
  const t = m.elsewhere;
  const [choice, setChoice] = useState<Choice>({ kind: "city", id: "athens" });
  const [coords, setCoords] = useState("");
  const [audio, setAudio] = useState<Audio | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const capture = useRef<Capture | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const nameOfCoords = useCallback(
    (lat: number, lon: number) => {
      const [n, s, e, w] = t.cardinals;
      const deg = (x: number) => x.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      // No-break spaces: "33.60° N" never splits over two lines.
      return `${deg(Math.abs(lat))}°\u00a0${lat >= 0 ? n : s}, ${deg(Math.abs(lon))}°\u00a0${lon >= 0 ? e : w}`;
    },
    [t.cardinals, locale],
  );
  const placeOf = useCallback((id: PlaceId): Place => ({ ...PLACES[id], name: t.places[id] }), [t.places]);
  const chosen = useMemo((): Place | null => {
    if (choice.kind === "city") return placeOf(choice.id);
    const typed = choice.kind === "coords" ? parseCoords(coords) : null;
    return typed ? { ...typed, name: nameOfCoords(typed.lat, typed.lon) } : null;
  }, [choice, coords, placeOf, nameOfCoords]);

  const stopRecording = useCallback(async () => {
    const c = capture.current;
    capture.current = null;
    setAnalyser(null);
    if (!c) return;
    const got = c.end();
    await c.close();
    if (!got) {
      setPhase({ kind: "error", code: "microphone" });
      return;
    }
    setAudio(trim(got.samples, got.sampleRate, null));
    setPhase({ kind: "idle" });
  }, []);

  useEffect(() => () => void capture.current?.close(), []);

  // The timer while recording, and the stop at the longest length used.
  useEffect(() => {
    if (phase.kind !== "recording") return;
    const id = setInterval(() => {
      const seconds = capture.current?.seconds ?? 0;
      if (seconds >= MAX_SECONDS) void stopRecording();
      else setPhase({ kind: "recording", seconds });
    }, 250);
    return () => clearInterval(id);
  }, [phase.kind, stopRecording]);

  const record = useCallback(async () => {
    // The audio context first, inside the tap: iOS only starts audio from a user gesture.
    const ctx = Capture.context();
    try {
      const stream = await openMicrophone();
      capture.current = await Capture.open(stream, ctx);
    } catch {
      if (ctx.state !== "closed") await ctx.close();
      setPhase({ kind: "error", code: "microphone" });
      return;
    }
    setAnalyser(capture.current.analyser);
    capture.current.begin();
    setAudio(null);
    setPhase({ kind: "recording", seconds: 0 });
  }, []);

  const pick = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      const { samples, rate } = await decodeFile(file);
      setAudio(trim(samples, rate, file.name));
      setPhase({ kind: "idle" });
    } catch {
      setPhase({ kind: "error", code: "decode" });
    }
  }, []);

  const make = useCallback(async () => {
    if (!audio) return;
    const seconds = audio.samples.length / audio.rate;
    if (seconds < MIN_SECONDS) return setPhase({ kind: "error", code: "short" });
    if (choice.kind === "coords" && !chosen) return setPhase({ kind: "error", code: "coords" });
    const tries: Place[] = choice.kind === "random" ? [...IDS].sort(() => Math.random() - 0.5).slice(0, TRIES).map(placeOf) : [chosen!];

    // The place: its first poll says whether a plane flies low enough there; two more give each flight's turn.
    let found: { place: Place; scene: Scene } | null = null;
    for (const [i, place] of tries.entries()) {
      setPhase({ kind: "working", step: choice.kind === "random" ? { kind: "searching", place: place.name } : { kind: "polls", place: place.name, i: 1 } });
      if (i > 0) await wait(POLL_EVERY);
      const w = await weatherOf(place.lat, place.lon);
      const centre: Listener = { lat: place.lat, lon: place.lon, elevation: w.elevation ?? 0 };
      const air = { groundTempC: w.temperatureC ?? 15 };
      const polls: Poll[] = [];
      try {
        polls.push(await pollAround(place.lat, place.lon));
      } catch {
        return setPhase({ kind: "error", code: "flights" });
      }
      if (!planScene(polls, centre, seconds, air)) continue;
      for (let k = 2; k <= POLLS; k++) {
        setPhase({ kind: "working", step: { kind: "polls", place: place.name, i: k } });
        await wait(POLL_EVERY);
        try {
          polls.push(await pollAround(place.lat, place.lon));
        } catch {
          // Two polls, or one, still make a scene: the flights just go straight.
        }
      }
      const scene = planScene(polls, centre, seconds, air, { seed: Math.floor(Math.random() * 1e9) });
      if (scene) {
        found = { place, scene };
        break;
      }
    }
    if (!found) return setPhase(choice.kind === "random" ? { kind: "error", code: "noPlaneAnywhere" } : { kind: "error", code: "noPlane", place: tries[0].name });
    const { scene, place } = found;

    setPhase({ kind: "working", step: { kind: "plant" } });
    await nextFrame();
    const voice = await resample(audio.samples, audio.rate, ANALYSIS_RATE);
    setPhase({ kind: "working", step: { kind: "check" } });
    await nextFrame();
    const level = await fit(voice, scene);
    // The file: the planes made at the analysis rate (all they sound is under 4 kHz), brought to
    // the recording's own rate, under the voice.
    const { planes } = level;
    const upsampled = await resample(planes, ANALYSIS_RATE, audio.rate);
    const out = new Float32Array(audio.samples.length);
    for (let i = 0; i < out.length; i++) out[i] = audio.samples[i] + (upsampled[i] ?? 0);
    const bytes = encodeWav(out, audio.rate);
    // The proof is read from the file itself, as anyone would: decoded, brought to 8 kHz, analysed at the spot.
    const decoded = decodeWav(bytes);
    const samples = await resample(decoded.samples, decoded.sampleRate, ANALYSIS_RATE);
    const rec: Recording = { samples, sampleRate: ANALYSIS_RATE, start: scene.start, listener: scene.spot, air: scene.air, polls: scene.polls };
    const analysis = await analyze(rec);
    const wav = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "audio/wav" }));
    const stamp = new Date(scene.start * 1000).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    setPhase({ kind: "done", done: { scene, place, analysis, rec, wav, file: `recording-${stamp}.wav`, underVoice: 20 * Math.log10(loudness(planes) / (loudness(voice) || 1)) } });
  }, [audio, choice, chosen, placeOf]);

  useEffect(() => {
    if (phase.kind !== "done") return;
    const url = phase.done.wav;
    return () => URL.revokeObjectURL(url);
  }, [phase]);

  if (phase.kind === "done") {
    return (
      <Outcome
        done={phase.done}
        onAgain={() => setPhase({ kind: "idle" })}
        onRestart={() => {
          setAudio(null);
          setPhase({ kind: "idle" });
        }}
      />
    );
  }

  if (phase.kind === "working") {
    const s = phase.step;
    const text =
      s.kind === "searching" ? fill(t.working.searching, { place: s.place }) : s.kind === "polls" ? fill(t.working.polls, { place: s.place, i: s.i, n: POLLS }) : s.kind === "plant" ? t.working.plant : t.working.check;
    const share = s.kind === "searching" ? 0.1 : s.kind === "polls" ? 0.1 + (0.4 * s.i) / POLLS : s.kind === "plant" ? 0.6 : 0.8;
    return (
      <div className="flex flex-col gap-4 py-10" aria-live="polite">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl" data-testid="elsewhere-step">
          {text}
        </h1>
        <div className="h-1 w-full max-w-md overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-amber transition-[width] duration-300" style={{ width: `${share * 100}%` }} />
        </div>
      </div>
    );
  }

  const recording = phase.kind === "recording";
  const seconds = audio ? audio.samples.length / audio.rate : 0;
  const chip = (pressed: boolean) =>
    `rounded-full border px-4 py-2 text-sm font-medium transition ${pressed ? "border-amber bg-amber/15 text-amber-soft" : "border-line text-ink hover:border-mute"}`;
  const error = phase.kind === "error" ? fill(t.errors[phase.code], { place: phase.place ?? chosen?.name ?? "" }) : null;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-5">
        <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">{t.title}</h1>
        <p className="max-w-prose text-lg text-pretty text-mute">{t.lead}</p>
      </header>

      <section className="flex flex-col gap-4" aria-labelledby="where">
        <h2 id="where" className="text-sm font-medium tracking-wide text-mute uppercase">
          <span className="font-mono text-amber">01</span> {t.place.title}
        </h2>
        <div className="flex flex-wrap gap-2" data-testid="places">
          {IDS.map((id) => (
            <button key={id} type="button" aria-pressed={choice.kind === "city" && choice.id === id} onClick={() => setChoice({ kind: "city", id })} className={chip(choice.kind === "city" && choice.id === id)}>
              {t.places[id]}
            </button>
          ))}
          <button type="button" aria-pressed={choice.kind === "random"} onClick={() => setChoice({ kind: "random" })} className={chip(choice.kind === "random")} data-testid="place-random">
            {t.place.random}
          </button>
          <button type="button" aria-pressed={choice.kind === "coords"} onClick={() => setChoice({ kind: "coords" })} className={chip(choice.kind === "coords")} data-testid="place-coords">
            {t.place.coords}
          </button>
        </div>
        {choice.kind === "coords" && (
          <label className="flex flex-col gap-2 text-sm text-mute sm:w-80">
            {t.place.coordsLabel}
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={coords}
              onChange={(e) => setCoords(e.target.value)}
              placeholder={t.place.coordsPlaceholder}
              className="rounded-xl border border-line bg-deep px-4 py-3 font-mono text-base text-ink placeholder:text-faint focus:border-amber focus:outline-none"
              data-testid="coords"
            />
          </label>
        )}
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="yours">
        <h2 id="yours" className="text-sm font-medium tracking-wide text-mute uppercase">
          <span className="font-mono text-amber">02</span> {t.audio.title}
        </h2>
        {recording ? (
          <div className="flex flex-col gap-4">
            {analyser && <Waterfall analyser={analyser} />}
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => void stopRecording()} className="rounded-full bg-amber px-6 py-3 font-medium text-night transition hover:bg-amber-soft" data-testid="record-stop">
                {t.audio.stop}
              </button>
              <span className="font-mono text-2xl text-ink tabular-nums">{clockOf(phase.seconds)}</span>
            </div>
          </div>
        ) : audio ? (
          <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-deep/70 p-4" data-testid="audio">
            <span className="min-w-0 flex-1 truncate font-medium">{audio.name ?? t.audio.voiceNote}</span>
            <span className="font-mono text-mute tabular-nums">{clockOf(seconds)}</span>
            <button type="button" onClick={() => setAudio(null)} className="rounded-full border border-line px-4 py-2 text-sm font-medium text-ink transition hover:border-mute">
              {t.audio.change}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={() => void record()} className="rounded-full border border-line px-6 py-3 font-medium text-ink transition hover:border-mute" data-testid="record">
              {t.audio.record}
            </button>
            <button type="button" onClick={() => fileInput.current?.click()} className="rounded-full border border-line px-6 py-3 font-medium text-ink transition hover:border-mute">
              {t.audio.file}
            </button>
            <input ref={fileInput} type="file" accept="audio/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} data-testid="file" />
          </div>
        )}
        <p className="max-w-prose text-sm text-pretty text-faint">
          {t.audio.note} {audio?.trimmed ? t.audio.trimmed : ""}
        </p>
      </section>

      {error && (
        <p role="alert" className="max-w-prose rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-pretty text-amber-soft" data-testid="elsewhere-error">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void make()}
        disabled={!audio || recording || (choice.kind === "coords" && !chosen)}
        className="w-full rounded-full bg-amber px-7 py-3.5 text-lg font-medium text-night transition enabled:hover:bg-amber-soft disabled:opacity-40 sm:w-fit"
        data-testid="make"
      >
        {chosen && choice.kind !== "random" ? fill(t.make, { place: chosen.name }) : t.makeRandom}
      </button>
    </div>
  );
}

const clockOf = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The band the matched curve went through. */
function bandOf(factor: Float32Array, f0: number): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of factor) {
    if (!Number.isFinite(f)) continue;
    lo = Math.min(lo, f * f0);
    hi = Math.max(hi, f * f0);
  }
  return Number.isFinite(lo) ? { lo, hi } : null;
}

/** What the file now says, what someone running the video's method would conclude, and the proof. */
function Outcome({ done, onAgain, onRestart }: { done: Done; onAgain: () => void; onRestart: () => void }) {
  const { m, f, fill, plural, locale } = useI18n();
  const t = m.elsewhere.result;
  const { scene, place, analysis, rec } = done;
  const { verdict } = analysis;
  const best = verdict.best;
  const named = best && verdict.kind !== "none" ? scene.planted.find((p) => p.meta.hex === best.id) ?? null : null;
  const pointed = named ?? scene.planted[0];
  const ids = useIdentities(scene.planted, place);
  const known = (meta: AircraftMeta) => ids.get(meta.hex) ?? identityOf(meta, null, null);
  const name = spoken(known(pointed.meta), m.article);
  const time = new Date(pointed.closest.at * 1000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
  const direction = m.elsewhere.compass[Math.round(scene.offset.bearing / 45) % 8];
  const [showCurve, setShowCurve] = useState(true);
  const match = named ? best : null;

  // The added plane brought out: the file sped up and filtered to the band of its curve.
  const band = useMemo(() => (match ? bandOf(match.factor, match.f0) : null), [match]);
  const speed = band ? speedFor(band.lo, band.hi) : 1;
  const [plane, setPlane] = useState<string | null>(null);
  useEffect(() => {
    if (!band) return;
    let url: string | null = null;
    let live = true;
    void revealed(rec.samples, rec.sampleRate, band.lo, band.hi, speed).then((u) => {
      url = u;
      if (live) setPlane(u);
      else URL.revokeObjectURL(u);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [rec, band, speed]);
  const times = String(speed) in m.hearIt.times ? m.hearIt.times[String(speed) as keyof typeof m.hearIt.times] : plural(speed, m.hearIt.times);

  const score = best ? Math.round(best.score * 10) / 10 : 0;
  const proof =
    verdict.kind === "strong" && named
      ? fill(t.proofStrong, { verdict: fill(m.result.strong, { name }), score, strong: STRONG.score })
      : verdict.kind === "possible" && named
        ? fill(t.proofPossible, { verdict: fill(m.result.possible, { name }), score, strong: STRONG.score })
        : fill(t.proofNone, { score, strong: STRONG.score });
  const map = `https://www.openstreetmap.org/?mlat=${scene.spot.lat.toFixed(5)}&mlon=${scene.spot.lon.toFixed(5)}#map=15/${scene.spot.lat.toFixed(5)}/${scene.spot.lon.toFixed(5)}`;

  return (
    <section className="flex flex-col gap-8" aria-live="polite">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-mute uppercase">
          <span className="rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 tracking-normal text-amber-soft normal-case">{t.chip}</span>
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl" data-testid="elsewhere-title">
          {fill(t.title, { place: place.name, time })}
        </h1>
        <p className="text-lg text-pretty text-mute" data-testid="elsewhere-spot">
          {fill(t.spot, { distance: f.km(scene.offset.distance), direction, name, range: f.km(pointed.closest.range), height: f.height(Math.max(0, pointed.closest.height)) })}
        </p>
        <p className="max-w-prose text-pretty text-mute">{t.conclusion}</p>
        <p className="text-sm">
          <a href={map} target="_blank" rel="noreferrer" className="text-amber-soft underline-offset-4 hover:underline">
            {t.map} <span aria-hidden>→</span>
          </a>
        </p>
      </header>

      <div className={`grid gap-4 ${plane ? "lg:grid-cols-2" : ""}`}>
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-deep p-4">
          <p className="font-medium">{fill(t.listen, { place: place.name })}</p>
          <p className="text-sm text-pretty text-mute">{fill(t.listenText, { db: Math.max(0, Math.round(-done.underVoice)) })}</p>
          <audio controls src={done.wav} className="w-full [color-scheme:dark]" preload="metadata" data-testid="elsewhere-audio" />
        </div>
        {plane && (
          <div className="flex flex-col gap-2 rounded-2xl border border-amber/30 bg-amber/5 p-4">
            <p className="font-medium text-amber-soft">{t.plane}</p>
            <p className="text-sm text-pretty text-mute">{fill(t.planeText, { times })}</p>
            <audio controls src={plane} className="w-full [color-scheme:dark]" preload="metadata" />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <a href={done.wav} download={done.file} className="rounded-full bg-amber px-6 py-3 text-center font-medium text-night transition hover:bg-amber-soft" data-testid="download">
          {t.download}
        </a>
        <button type="button" onClick={onAgain} className="rounded-full border border-line px-6 py-3 font-medium text-ink transition hover:border-mute" data-testid="again">
          {t.again}
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <Spectrum analysis={analysis} match={match} showCurve={showCurve} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-pretty text-mute">{t.curve}</p>
          {match && (
            <button type="button" onClick={() => setShowCurve((v) => !v)} className="shrink-0 rounded-full border border-amber/50 px-4 py-2 text-sm font-medium text-amber-soft transition hover:bg-amber/10">
              {showCurve ? m.result.hideCurve : m.result.showCurve}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-amber/30 bg-amber/5 p-5" data-testid="proof">
        <h2 className="text-sm font-medium tracking-wide text-amber-soft uppercase">{t.proofTitle}</h2>
        <p className="max-w-prose text-pretty text-ink" data-testid="proof-text">
          {proof}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium tracking-wide text-mute uppercase">{plural(scene.planted.length, t.added)}</h2>
        <ol className="flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-deep" data-testid="added">
          {scene.planted.map((p) => {
            const id = known(p.meta);
            const top = p === pointed;
            return (
              <li key={p.meta.hex} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                <span className={`font-medium ${top ? "text-amber-soft" : ""}`}>{id.title}</span>
                <span className="text-sm text-faint">
                  {[m.elsewhere.kinds[p.kind], fill(m.result.atClosest, { distance: f.km(p.closest.range) }), top ? t.pointed : null].filter(Boolean).join(" · ")}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <ul className="flex flex-col gap-2 text-sm text-mute">
        {t.limits.map((line) => (
          <li key={line} className="flex max-w-prose items-baseline gap-3 text-pretty">
            <span aria-hidden className="size-1.5 shrink-0 translate-y-[-0.15em] rounded-full bg-amber/70" />
            {line}
          </li>
        ))}
      </ul>

      <div>
        <button type="button" onClick={onRestart} className="rounded-full border border-line px-6 py-3 font-medium text-ink transition hover:border-mute">
          {t.restart}
        </button>
      </div>
    </section>
  );
}
