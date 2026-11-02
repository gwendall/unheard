"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Capture, keepAwake, openMicrophone, resample } from "@/lib/audio";
import { analyze, ANALYSIS_RATE, type Analysis, type Recording } from "@/lib/core/pipeline";
import type { Air } from "@/lib/core/doppler";
import type { Listener as Spot } from "@/lib/core/geo";
import { makeBundle } from "@/lib/bundle";
import { Sky } from "@/lib/client/sky";
import { nearbyFrom, type Nearby } from "@/lib/client/nearby";
import { buildExample } from "@/lib/client/example";
import { clock, describe, km, nameOf } from "@/lib/client/format";
import { Waterfall } from "./Waterfall";
import { Result } from "./Result";

const WARM_UP = 6_000;
const MIN_SECONDS = 30;
const MAX_SECONDS = 300;

type Phase =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "warming" }
  | { kind: "recording" }
  | { kind: "analyzing"; done: number; total: number }
  | { kind: "result"; analysis: Analysis; rec: Recording; example: boolean }
  | { kind: "error"; message: string };

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

export function Listener() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [nearby, setNearby] = useState<Nearby[]>([]);
  const [seen, setSeen] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const capture = useRef<Capture | null>(null);
  const sky = useRef<Sky | null>(null);
  const spot = useRef<{ listener: Spot; air: Air } | null>(null);
  const release = useRef<() => void>(() => {});
  const device = useRef<{ userAgent: string; inputSampleRate: number; settings: Record<string, unknown> } | null>(null);
  const captureMode = useCaptureMode();

  const teardown = useCallback(async () => {
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

  const listen = useCallback(async () => {
    // The audio context comes first, inside the tap: iOS only starts audio from a user gesture.
    const ctx = Capture.context();
    setPhase({ kind: "asking" });
    setNearby([]);
    setSeen(0);
    setElapsed(0);
    let stream: MediaStream;
    try {
      stream = await openMicrophone();
    } catch {
      await ctx.close();
      setPhase({ kind: "error", message: "Unheard needs the microphone to listen. Allow it for this site and try again." });
      return;
    }
    let where: GeolocationPosition;
    try {
      where = await position();
    } catch {
      for (const t of stream.getTracks()) t.stop();
      await ctx.close();
      setPhase({ kind: "error", message: "Unheard needs your location to know which planes are around you. Allow it for this site and try again." });
      return;
    }
    const { latitude: lat, longitude: lon, altitude, altitudeAccuracy } = where.coords;
    const w = await weather(lat, lon);
    const gps = altitude !== null && altitudeAccuracy !== null && altitudeAccuracy < 30 ? altitude : null;
    spot.current = { listener: { lat, lon, elevation: gps ?? w.elevation ?? 0 }, air: { groundTempC: w.temperatureC ?? 15 } };

    try {
      capture.current = await Capture.open(stream, ctx);
    } catch {
      for (const t of stream.getTracks()) t.stop();
      await ctx.close();
      setPhase({ kind: "error", message: "This browser could not open the microphone for recording. Try another browser." });
      return;
    }
    setAnalyser(capture.current.analyser);

    const listener = spot.current.listener;
    const seenIds = new Set<string>();
    sky.current = new Sky(lat, lon, (poll) => {
      for (const a of poll.aircraft) seenIds.add(a.hex);
      setSeen(seenIds.size);
      setNearby(nearbyFrom(poll, listener));
    });
    sky.current.start();
    setPhase({ kind: "warming" });

    // Follow the planes for a few seconds first: the sound heard at the start left them earlier.
    await new Promise((r) => setTimeout(r, WARM_UP));
    if (!capture.current) return;
    capture.current.begin();
    release.current = await keepAwake();
    setPhase({ kind: "recording" });
  }, []);

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
      setPhase({ kind: "error", message: "Nothing was recorded. Check that the microphone works and try again." });
      return;
    }
    setPhase({ kind: "analyzing", done: 0, total: 0 });
    await nextFrame();
    const samples = await resample(captured.samples, captured.sampleRate, ANALYSIS_RATE);
    const rec: Recording = { samples, sampleRate: ANALYSIS_RATE, start: captured.start, listener: where.listener, air: where.air, polls: s.polls };
    const analysis = await analyze(rec, {}, (done, total) => setPhase({ kind: "analyzing", done, total }));
    device.current = { userAgent: navigator.userAgent, inputSampleRate, settings: settings as Record<string, unknown> };
    setPhase({ kind: "result", analysis, rec, example: false });
  }, [teardown]);

  const example = useCallback(async () => {
    setPhase({ kind: "analyzing", done: 0, total: 0 });
    await nextFrame();
    const rec = buildExample();
    const analysis = await analyze(rec, {}, (done, total) => setPhase({ kind: "analyzing", done, total }));
    device.current = null;
    setPhase({ kind: "result", analysis, rec, example: true });
  }, []);

  const cancel = useCallback(async () => {
    await teardown();
    setPhase({ kind: "idle" });
  }, [teardown]);

  // The timer and the automatic stop.
  useEffect(() => {
    if (phase.kind !== "recording") return;
    const id = setInterval(() => {
      const s = capture.current?.seconds ?? 0;
      setElapsed(s);
      if (s >= MAX_SECONDS) void finish();
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
          onBundle={captureMode ? () => download(phase.rec, phase.analysis) : null}
          onAgain={() => {
            setPhase({ kind: "idle" });
            void listen();
          }}
        />
      </Shell>
    );
  }

  if (phase.kind === "idle" || phase.kind === "error") {
    return (
      <Shell>
        <Hero onListen={() => void listen()} onExample={() => void example()} error={phase.kind === "error" ? phase.message : null} />
      </Shell>
    );
  }

  if (phase.kind === "analyzing") {
    return (
      <Shell>
        <div className="flex flex-col gap-4 py-10" aria-live="polite">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Looking for the plane in your recording</h2>
          <p className="text-mute">{phase.total ? `Checking ${Math.min(phase.done + 1, phase.total)} of ${phase.total} planes` : "Reading the sound"}</p>
          <div className="h-1 w-full max-w-md overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-amber transition-[width] duration-300" style={{ width: `${phase.total ? (phase.done / phase.total) * 100 : 8}%` }} />
          </div>
        </div>
      </Shell>
    );
  }

  const recording = phase.kind === "recording";
  const left = Math.max(0, Math.ceil(MIN_SECONDS - elapsed));
  return (
    <Shell>
      <div className="flex flex-col gap-6" aria-live="polite">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {phase.kind === "asking" ? "Allow the microphone and your location" : recording ? "Listening" : "Finding the planes around you"}
            </h2>
            <p className="text-pretty text-mute">
              {phase.kind === "asking" && "Unheard needs both: the sound to find the curve, your position to know which planes could have made it."}
              {phase.kind === "warming" && `Following ${seen} ${seen === 1 ? "plane" : "planes"} nearby. Recording starts in a moment.`}
              {recording && (left > 0 ? `Hold still. Keep going at least ${left} more seconds.` : "Stop once a plane has passed. Propellers and rotors work best.")}
            </p>
          </div>
          {recording && (
            <div className="font-mono text-3xl tabular-nums text-ink sm:text-4xl" data-testid="timer">
              {clock(elapsed)}
            </div>
          )}
        </div>

        {analyser && <Waterfall analyser={analyser} />}

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => void finish()}
            disabled={!recording || left > 0}
            className="rounded-full bg-amber px-6 py-3 font-medium text-night transition enabled:hover:bg-amber-soft disabled:opacity-40"
            data-testid="stop"
          >
            Stop and find the plane
          </button>
          <button type="button" onClick={() => void cancel()} className="rounded-full border border-line px-6 py-3 font-medium text-ink transition hover:border-mute">
            Cancel
          </button>
        </div>

        {nearby.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium tracking-wide text-mute uppercase">Around you now</h3>
            <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-deep">
              {nearby.map((n) => (
                <li key={n.meta.hex} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{nameOf(n.meta)}</div>
                    <div className="truncate text-sm text-faint">{describe(n.meta) || "Unknown type"}</div>
                  </div>
                  <div className="shrink-0 text-right text-sm">
                    <div className="font-mono tabular-nums">{km(n.distance)}</div>
                    <div className="text-faint">{n.closestIn > 5 && n.closestIn < 900 ? `closest in ${Math.round(n.closestIn)} s, ${km(n.closestAt)}` : "moving away"}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl px-5 pt-14 pb-16 sm:px-8 sm:pt-24">{children}</div>;
}

function Hero({ onListen, onExample, error }: { onListen: () => void; onExample: () => void; error: string | null }) {
  return (
    <div className="relative isolate flex flex-col gap-6">
      <HeroCurves />
      <p className="font-mono text-sm tracking-[0.2em] text-amber uppercase">Unheard</p>
      <h1 className="text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl">There&apos;s a plane you can&apos;t hear.</h1>
      <p className="max-w-prose text-lg text-pretty text-mute sm:text-xl">
        Hold your phone up to the sky for a couple of minutes. Unheard finds the faint drone hiding in the background noise and tells you which plane made it.
      </p>
      {error && (
        <p role="alert" className="max-w-prose rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-pretty text-amber-soft">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="button" onClick={onListen} className="rounded-full bg-amber px-7 py-3.5 text-lg font-medium text-night transition hover:bg-amber-soft" data-testid="listen">
          Listen to the sky
        </button>
        <button type="button" onClick={onExample} className="rounded-full border border-line px-7 py-3.5 text-lg font-medium text-ink transition hover:border-mute" data-testid="example">
          See an example
        </button>
      </div>
      <p className="text-sm text-faint">Your recording never leaves your phone.</p>
    </div>
  );
}

// Three harmonics of a Doppler curve, as a spectrum would show a plane passing: decoration only.
const CURVES = [1, 2, 3].map((h) => {
  const pts: string[] = [];
  for (let x = 0; x <= 640; x += 8) {
    const f = 1 + 0.16 * Math.tanh(-(x - 330) / 70);
    pts.push(`${x},${(380 - h * 105 * f).toFixed(1)}`);
  }
  return { h, d: `M${pts.join(" L")}` };
});

function HeroCurves() {
  return (
    <svg aria-hidden viewBox="0 0 640 380" className="pointer-events-none absolute top-16 -right-4 -z-10 hidden w-[42%] opacity-50 lg:block" fill="none">
      <defs>
        <linearGradient id="hero-fade" x1="0" x2="1">
          <stop offset="0" stopColor="#ffb547" stopOpacity="0" />
          <stop offset="0.35" stopColor="#ffb547" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffb547" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      {CURVES.map(({ h, d }) => (
        <path key={h} d={d} stroke="url(#hero-fade)" strokeWidth={h === 1 ? 2.5 : 1.5} strokeOpacity={1 / h} strokeLinecap="round" />
      ))}
    </svg>
  );
}
