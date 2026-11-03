import { describe, expect, it } from "vitest";
import { anonymize, EPOCH, ORIGIN } from "./anonymize";
import { makeBundle, recordingOf } from "./bundle";
import { buildExample, EXAMPLE_TARGET } from "./client/example";
import { analyze } from "./core/pipeline";

const START = 1_800_000_000;

function donated(turn: number, wind?: [number, number, number]) {
  const rec = buildExample(START);
  if (wind) rec.air = { ...rec.air, wind };
  const device = { userAgent: "test", inputSampleRate: 48000, settings: { deviceId: "abc123secret", groupId: "grp456secret", sampleRate: 48000, echoCancellation: false } };
  const bundle = makeBundle(rec, { app: "test", device, answer: { kind: "strong", id: EXAMPLE_TARGET, score: 12, f0: 92, clock: 0 } });
  bundle.truth = { heard: EXAMPLE_TARGET, note: "seen overhead" };
  return { rec, bundle, anon: anonymize(bundle, turn) };
}

describe("anonymize", () => {
  it("leaves no place, time or aircraft identity in the bundle", () => {
    const { rec, anon } = donated(137);
    const text = JSON.stringify({ ...anon, recording: { ...anon.recording, wav: "" } });
    expect(anon.anonymous).toBe(true);
    expect(anon.recording.listener).toEqual(ORIGIN);
    expect(anon.recording.start).toBe(EPOCH);
    expect(anon.capturedAt).toBe("2000-01-01T00:00:00.000Z");
    for (const poll of rec.polls) {
      for (const a of poll.aircraft) {
        expect(text).not.toContain(a.hex);
        if (a.flight) expect(text).not.toContain(a.flight);
        if (a.r) expect(text).not.toContain(a.r);
      }
    }
    expect(text).not.toContain(String(rec.listener.lat).slice(0, 6));
    expect(text).not.toContain("secret");
    expect(anon.device!.settings).toEqual({ sampleRate: 48000, echoCancellation: false });
    // Every position sits within the 30 km the page polls, around 0° 0°.
    for (const a of anon.recording.polls.flatMap((p) => p.aircraft)) {
      expect(Math.abs(a.lat!)).toBeLessThan(0.5);
      expect(Math.abs(a.lon!)).toBeLessThan(0.5);
    }
    expect(anon.answer!.id).toBe(anon.truth!.heard);
    expect(anon.answer!.id).toMatch(/^x\d\d$/);
  });

  it("changes nothing for the analysis, whatever the turn and the wind", async () => {
    for (const [turn, wind] of [[0, undefined], [137, undefined], [251, [4, -3, 0]]] as const) {
      const { bundle, anon } = donated(turn, wind ? [...wind] : undefined);
      const before = await analyze(recordingOf(bundle));
      const after = await analyze(recordingOf(anon));
      expect(after.verdict.kind, `turn ${turn}`).toBe(before.verdict.kind);
      expect(after.verdict.best!.id).toBe(anon.truth!.heard);
      expect(after.verdict.best!.score).toBeCloseTo(before.verdict.best!.score, 3);
      expect(after.verdict.best!.f0).toBeCloseTo(before.verdict.best!.f0, 3);
      expect(after.verdict.best!.closest!.range).toBeCloseTo(before.verdict.best!.closest!.range, 1);
      const scores = (v: typeof before) => v.verdict.ranked.map((m) => m.score.toFixed(3)).sort();
      expect(scores(after)).toEqual(scores(before));
    }
  });
});
