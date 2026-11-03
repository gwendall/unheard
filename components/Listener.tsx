"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Capture, keepAwake, openMicrophone, resample } from "@/lib/audio";
import { analyze, ANALYSIS_RATE, type Analysis, type Recording } from "@/lib/core/pipeline";
import type { Air } from "@/lib/core/doppler";
import type { Listener as Spot } from "@/lib/core/geo";
import { makeBundle, type Bundle } from "@/lib/bundle";
import { Sky } from "@/lib/client/sky";
import { nearbyFrom, type Nearby } from "@/lib/client/nearby";
import { buildExample } from "@/lib/client/example";
import { outlook, type Outlook } from "@/lib/client/chance";
import type { Messages } from "@/lib/i18n";
import { useI18n } from "./I18n";
import { Waterfall } from "./Waterfall";
import { Hero } from "./Hero";
import { Result } from "./Result";
import { countdown, ranked, SkyList, titleOf, useIdentities } from "./SkyList";

/** Flight data followed before the first recorded sample: the sound heard first left the planes earlier. */
const WARM_UP = 6_000;
const MIN_SECONDS = 30;
const MAX_SECONDS = 300;
/** Polling while only watching the sky, and how long the page watches before it pauses. */
const WATCH_EVERY = 5_000;
const WATCH_FOR = 10 * 60_000;
/** Seconds kept after the awaited plane's closest pass (as heard) before stopping on its own. */
const AFTER = 25;
const SPEED_OF_SOUND = 340;

type Phase =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "sky" }
  | { kind: "paused" }
  | { kind: "asking" }
  | { kind: "recording" }
  | { kind: "analyzing"; done: number; total: number }
  | { kind: "result"; analysis: Analysis; rec: Recording; example: boolean; device: Bundle["device"] | null }
  | { kind: "error"; code: keyof Messages["sky"]["errors"] };

const noop = () => () => {};
const useCaptureMode = () => useSyncExternalStore(noop, () => new URLSearchParams(window.location.search).has("capture"), () => false);

function position(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 }));
}

async function weather(lat: number, lon: number): Promise<{ elevation: number | null; temperatureC: number | null }> {
  try {
    const res = await fetch(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
    return await res.json();
  } catch {
    return { elevation: null, temperatureC: null };
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export function Listener({ qr }: { qr: string }) {
  const { m, f, fill, plural } = useI18n();
  const t = m.sky;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [around, setAround] = useState<{ list: Nearby[]; receivedAt: number; polled: boolean }>({ list: [], receivedAt: 0, polled: false });
  const [now, setNow] = useState(0);
  const [target, setTarget] = useState<string | null>(null);
  const [where, setWhere] = useState<{ lat: number; lon: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const capture = useRef<Capture | null>(null);
  const sky = useRef<Sky | null>(null);
  const skyFrom = useRef(0);
  const spot = useRef<{ listener: Spot; air: Air } | null>(null);
  const release = useRef<() => void>(() => {});
  // Read by the poll callback and the timer, which outlive a render.
  const recordingRef = useRef(false);
  const targetRef = useRef<string | null>(null);
  const aroundRef = useRef<{ list: Nearby[]; receivedAt: number }>({ list: [], receivedAt: 0 });
  const lastKind = useRef<Outlook["kind"] | null>(null);
  const device = useRef<{ userAgent: string; inputSampleRate: number; settings: Record<string, unknown> } | null>(null);
  const captureMode = useCaptureMode();
  const shown = useMemo(() => ranked(around.list), [around.list]);
  const ids = useIdentities(shown, where);

  const teardown = useCallback(async () => {
    recordingRef.current = false;
    sky.current?.stop();
    sky.current = null;
    release.current();
    release.current = () => {};
    const c = capture.current;
    capture.current = null;
    setAnalyser(null);
    await c?.close();
  }, []);

  useEffect(() => () => void teardown(), [teardown]);

  // Each poll: the aircraft around, the one to wait for while recording, a buzz when one comes.
  const onPoll = useCallback((list: Nearby[]) => {
    const receivedAt = Date.now();
    aroundRef.current = { list, receivedAt };
    setAround({ list, receivedAt, polled: true });
    setNow(receivedAt);
    const o = outlook(list);
    if (recordingRef.current) {
      const kept = list.find((n) => n.meta.hex === targetRef.current);
      if (!kept || kept.closestIn < -90) {
        targetRef.current = o.kind === "quiet" ? null : o.best.meta.hex;
        setTarget(targetRef.current);
      }
    } else if (lastKind.current === "quiet" && o.kind !== "quiet") {
      navigator.vibrate?.(200);
    }
    lastKind.current = o.kind;
  }, []);

  // First tap: where the listener is, then the sky around them. No microphone yet.
  const look = useCallback(async () => {
    setPhase({ kind: "locating" });
    setAround({ list: [], receivedAt: 0, polled: false });
    setTarget(null);
    targetRef.current = null;
    lastKind.current = null;
    setElapsed(0);
    let at: GeolocationPosition;
    try {
      at = await position();
    } catch {
      setPhase({ kind: "error", code: "location" });
      return;
    }
    const { latitude: lat, longitude: lon, altitude, altitudeAccuracy } = at.coords;
    setWhere({ lat, lon });
    const listener: Spot = { lat, lon, elevation: 0 };
    spot.current = { listener, air: { groundTempC: 15 } };
    sky.current = new Sky(lat, lon, (poll) => onPoll(nearbyFrom(poll, listener, Infinity)), WATCH_EVERY);
    sky.current.start();
    skyFrom.current = Date.now();
    release.current = await keepAwake();
    setPhase({ kind: "sky" });
    const w = await weather(lat, lon);
    const gps = altitude !== null && altitudeAccuracy !== null && altitudeAccuracy < 30 ? altitude : null;
    listener.elevation = gps ?? w.elevation ?? 0;
    spot.current.air = { groundTempC: w.temperatureC ?? 15 };
  }, [onPoll]);

  // Second tap: the microphone, then the recording.
  const listen = useCallback(async () => {
    // The audio context comes first, inside the tap: iOS only starts audio from a user gesture.
    const ctx = Capture.context();
    setPhase({ kind: "asking" });
    let stream: MediaStream;
    try {
      stream = await openMicrophone();
    } catch {
      await ctx.close();
      await teardown();
      setPhase({ kind: "error", code: "microphone" });
      return;
    }
    try {
      capture.current = await Capture.open(stream, ctx);
    } catch {
      for (const t of stream.getTracks()) t.stop();
      await ctx.close();
      await teardown();
      setPhase({ kind: "error", code: "recorder" });
      return;
    }
    setAnalyser(capture.current.analyser);
    const wait = WARM_UP - (Date.now() - skyFrom.current);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!capture.current) return;
    capture.current.begin();
    sky.current?.pace(2000);
    const o = outlook(aroundRef.current.list);
    targetRef.current = o.kind === "quiet" ? null : o.best.meta.hex;
    setTarget(targetRef.current);
    recordingRef.current = true;
    setPhase({ kind: "recording" });
  }, [teardown]);

  const finish = useCallback(async () => {
    const c = capture.current;
    const s = sky.current;
    const where = spot.current;
    if (!c || !s || !where) return;
    s.stop();
    const captured = c.end();
    const inputSampleRate = c.inputSampleRate;
    const settings = c.settings;
    await teardown();
    if (!captured) {
      setPhase({ kind: "error", code: "nothing" });
      return;
    }
    setPhase({ kind: "analyzing", done: 0, total: 0 });
    await nextFrame();
    const samples = await resample(captured.samples, captured.sampleRate, ANALYSIS_RATE);
    const rec: Recording = { samples, sampleRate: ANALYSIS_RATE, start: captured.start, listener: where.listener, air: where.air, polls: s.polls };
    const analysis = await analyze(rec, {}, (done, total) => setPhase({ kind: "analyzing", done, total }));
    device.current = { userAgent: navigator.userAgent, inputSampleRate, settings: settings as Record<string, unknown> };
    setPhase({ kind: "result", analysis, rec, example: false, device: device.current });
  }, [teardown]);

  const example = useCallback(async () => {
    setPhase({ kind: "analyzing", done: 0, total: 0 });
    await nextFrame();
    const rec = buildExample();
    const analysis = await analyze(rec, {}, (done, total) => setPhase({ kind: "analyzing", done, total }));
    device.current = null;
    setPhase({ kind: "result", analysis, rec, example: true, device: null });
  }, []);

  const cancel = useCallback(async () => {
    await teardown();
    setPhase({ kind: "idle" });
  }, [teardown]);

  // The clock of the countdowns while the sky is shown, and a pause after a while: every poll
  // costs the free flight data service a request.
  useEffect(() => {
    if (phase.kind !== "sky") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    const pause = setTimeout(() => {
      void teardown().then(() => setPhase({ kind: "paused" }));
    }, WATCH_FOR);
    return () => {
      clearInterval(id);
      clearTimeout(pause);
    };
  }, [phase.kind, teardown]);

  // The timer and the automatic stop: at the limit, or once the awaited plane has passed.
  useEffect(() => {
    if (phase.kind !== "recording") return;
    const id = setInterval(() => {
      const s = capture.current?.seconds ?? 0;
      const at = Date.now();
      setElapsed(s);
      setNow(at);
      const { list, receivedAt } = aroundRef.current;
      const awaited = list.find((n) => n.meta.hex === targetRef.current);
      const passed = awaited ? countdown(awaited, receivedAt, at) + awaited.closestAt / SPEED_OF_SOUND < -AFTER : false;
      if (s >= MAX_SECONDS || (s >= MIN_SECONDS && passed)) void finish();
    }, 250);
    return () => clearInterval(id);
  }, [phase.kind, finish]);

  const download = useCallback((rec: Recording, analysis: Analysis) => {
    const best = analysis.verdict.best;
    const bundle = makeBundle(rec, {
      app: process.env.NEXT_PUBLIC_COMMIT ?? "dev",
      device: device.current ?? undefined,
      answer: { kind: analysis.verdict.kind, id: best?.id ?? null, score: best?.score ?? null, f0: best?.f0 ?? null, clock: best?.clock ?? null },
    });
    const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `unheard-${bundle.capturedAt.replace(/[:.]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }, []);

  if (phase.kind === "result") {
    return (
      <Shell>
        <Result
          analysis={phase.analysis}
          rec={phase.rec}
          example={phase.example}
          device={phase.device}
          onBundle={captureMode ? () => download(phase.rec, phase.analysis) : null}
          onAgain={() => void look()}
        />
      </Shell>
    );
  }

  if (phase.kind === "idle" || phase.kind === "error") {
    return (
      <Shell>
        <Hero onListen={() => void look()} onExample={() => void example()} error={phase.kind === "error" ? t.errors[phase.code] : null} qr={qr} />
      </Shell>
    );
  }

  if (phase.kind === "analyzing") {
    return (
      <Shell>
        <div className="flex flex-col gap-4 py-10" aria-live="polite">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{t.analyzing.title}</h2>
          <p className="text-mute">{phase.total ? fill(t.analyzing.checking, { i: Math.min(phase.done + 1, phase.total), n: phase.total }) : t.analyzing.reading}</p>
          <div className="h-1 w-full max-w-md overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-amber transition-[width] duration-300" style={{ width: `${phase.total ? (phase.done / phase.total) * 100 : 8}%` }} />
          </div>
        </div>
      </Shell>
    );
  }

  const recording = phase.kind === "recording";
  const left = Math.max(0, Math.ceil(MIN_SECONDS - elapsed));
  const o = outlook(around.list);
  const awaited = recording ? around.list.find((n) => n.meta.hex === target) ?? null : null;
  const { title, text } = headline();

  function headline(): { title: string; text: string } {
    if (phase.kind === "locating") return t.locating;
    if (phase.kind === "asking") return t.asking;
    if (recording) {
      if (!awaited) return { title: t.listening.title, text: left > 0 ? plural(left, t.listening.hold) : t.listening.stop };
      const name = titleOf(awaited, ids);
      const closest = countdown(awaited, around.receivedAt, now);
      // When its closest sound reaches the phone: what passing and passed are measured against.
      const heard = closest + awaited.closestAt / SPEED_OF_SOUND;
      if (heard > 15) return { title: fill(t.coming.title, { name }), text: fill(t.coming.text, { when: f.clock(closest), distance: f.km(awaited.closestAt) }) };
      if (heard >= -15) return { title: fill(t.passing.title, { name }), text: t.passing.text };
      const stopIn = Math.max(0, Math.ceil(heard + AFTER));
      return { title: fill(t.passed.title, { name }), text: left > 0 ? plural(left, t.passed.more) : fill(t.passed.stopping, { n: stopIn }) };
    }
    if (phase.kind === "paused") return t.paused;
    if (!around.polled) return t.looking;
    if (o.kind === "coming") {
      const left = countdown(o.best, around.receivedAt, now);
      return { title: fill(t.chance.title, { name: titleOf(o.best, ids), distance: f.km(o.at), when: f.clock(Math.max(0, left)) }), text: t.chance.text };
    }
    if (o.kind === "passing") return { title: fill(t.now.title, { name: titleOf(o.best, ids), distance: f.km(o.best.distance) }), text: t.now.text };
    const nearest = o.nearest
      ? fill(t.quiet.nearest, { name: titleOf(o.nearest, ids), distance: f.km(o.nearest.distance), height: f.height(Math.max(0, o.nearest.height)) })
      : "";
    return o.count ? { title: t.quiet.title, text: plural(o.count, t.quiet.text, { nearest }) } : t.empty;
  }

  const chance = o.kind !== "quiet";
  return (
    <Shell>
      <div className="flex flex-col gap-6" aria-live="polite">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl" data-testid="sky-title">
              {title}
            </h2>
            <p className="max-w-prose text-pretty text-mute">{text}</p>
          </div>
          {recording && (
            <div className="font-mono text-3xl tabular-nums text-ink sm:text-4xl" data-testid="timer">
              {f.clock(elapsed)}
            </div>
          )}
        </div>

        {analyser && <Waterfall analyser={analyser} />}

        <div className="flex flex-col gap-3 sm:flex-row">
          {phase.kind === "sky" && (
            <button
              type="button"
              onClick={() => void listen()}
              disabled={!around.polled}
              className={`rounded-full px-6 py-3 font-medium transition disabled:opacity-40 ${chance ? "bg-amber text-night enabled:hover:bg-amber-soft" : "border border-line text-ink enabled:hover:border-mute"}`}
              data-testid="start"
            >
              {chance ? t.start : t.anyway}
            </button>
          )}
          {phase.kind === "paused" && (
            <button type="button" onClick={() => void look()} className="rounded-full bg-amber px-6 py-3 font-medium text-night transition hover:bg-amber-soft" data-testid="watch">
              {t.watch}
            </button>
          )}
          {(recording || phase.kind === "asking") && (
            <button
              type="button"
              onClick={() => void finish()}
              disabled={!recording || left > 0}
              className="rounded-full bg-amber px-6 py-3 font-medium text-night transition enabled:hover:bg-amber-soft disabled:opacity-40"
              data-testid="stop"
            >
              {t.stop}
            </button>
          )}
          <button type="button" onClick={() => void cancel()} className="rounded-full border border-line px-6 py-3 font-medium text-ink transition hover:border-mute">
            {t.cancel}
          </button>
        </div>

        <SkyList list={phase.kind === "paused" ? [] : shown} ids={ids} receivedAt={around.receivedAt} now={now} target={awaited?.meta.hex ?? null} />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-5 pt-10 pb-16 sm:px-8 sm:pt-16">{children}</div>;
}
