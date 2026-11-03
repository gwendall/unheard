"use client";

import { upload } from "@vercel/blob/client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { anonymize } from "@/lib/anonymize";
import { encodeWav, makeBundle, type Bundle } from "@/lib/bundle";
import type { Analysis, Recording } from "@/lib/core/pipeline";
import { checkDonation, DONATION_PATH } from "@/lib/donation";
import type { AircraftMeta } from "@/lib/adsb";
import { useFormat, useLang, useT } from "@/lib/i18n/client";

const UNSURE = "unsure";
const NONE = "none";

type State = { kind: "form" } | { kind: "sending" } | { kind: "sent"; id: string } | { kind: "error"; message: string };

/** Lets someone give a real recording, anonymised on the phone, to the dataset the evals run on. */
export function Donate({ rec, analysis, device, title }: { rec: Recording; analysis: Analysis; device: Bundle["device"] | null; title: (meta: AircraftMeta) => string }) {
  const { verdict } = analysis;
  const named = verdict.kind === "none" ? null : verdict.best;
  const [heard, setHeard] = useState<string>(named?.id ?? UNSURE);
  const [note, setNote] = useState("");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<State>({ kind: "form" });
  const t = useT().donate;
  const lang = useLang();
  const f = useFormat();
  // The exact sound that would be sent, to listen to before giving it.
  const audio = useMemo(() => URL.createObjectURL(new Blob([encodeWav(rec.samples, rec.sampleRate).slice().buffer], { type: "audio/wav" })), [rec]);
  useEffect(() => () => URL.revokeObjectURL(audio), [audio]);

  async function give() {
    setState({ kind: "sending" });
    try {
      const best = verdict.best;
      const bundle = makeBundle(rec, {
        app: process.env.NEXT_PUBLIC_COMMIT ?? "dev",
        device: device ?? undefined,
        answer: { kind: verdict.kind, id: best?.id ?? null, score: best?.score ?? null, f0: best?.f0 ?? null, clock: best?.clock ?? null },
      });
      if (heard !== UNSURE) bundle.truth = { heard: heard === NONE ? null : heard, note: note.trim().slice(0, 500) };
      const donation = anonymize(bundle);
      const problems = checkDonation(donation);
      if (problems.length) throw new Error(problems.join("; "));
      const body = new Blob([JSON.stringify(donation)], { type: "application/json" });
      const blob = await upload(DONATION_PATH, body, { access: "private", handleUploadUrl: "/api/donate", contentType: "application/json", multipart: body.size > 4_000_000 });
      setState({ kind: "sent", id: blob.pathname.replace(/^donations\/v1\/recording-?/, "").replace(/\.json$/, "") });
    } catch (error) {
      setState({ kind: "error", message: (error as Error).message });
    }
  }

  const removal = state.kind === "sent" ? t.removal(state.id) : [];
  if (state.kind === "sent") {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-deep p-5" data-testid="donated">
        <h3 className="font-medium text-balance">{t.thanks}</h3>
        <p className="text-sm text-pretty text-mute">
          {removal[0]}
          <span className="font-mono text-ink">{removal[1]}</span>
          {removal[2]}
          <a href="mailto:unheard@gwendall.com" className="text-amber-soft underline-offset-4 hover:underline">
            {removal[3]}
          </a>
          {removal[4]}
        </p>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-2xl border border-line bg-deep p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void give();
      }}
      data-testid="donate"
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-balance">{t.title}</h3>
        <p className="text-sm text-pretty text-mute">
          {t.why}{" "}
          <Link href={`/${lang}/privacy`} className="text-amber-soft underline-offset-4 hover:underline">
            {t.whatIsSent}
          </Link>
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm text-mute">
        {t.listen}
        <audio controls src={audio} className="w-full" />
      </label>

      <label className="flex flex-col gap-1 text-sm text-mute">
        {t.heard}
        <select value={heard} onChange={(e) => setHeard(e.target.value)} className="rounded-lg border border-line bg-night px-3 py-2 text-ink" data-testid="donate-heard">
          {verdict.ranked.slice(0, 8).map((m) => (
            <option key={m.id} value={m.id}>
              {`${title(m.meta)}${m.closest ? t.atClosest(f.km(m.closest.range)) : ""}`}
            </option>
          ))}
          <option value={NONE}>{t.none}</option>
          <option value={UNSURE}>{t.unsure}</option>
        </select>
      </label>

      {heard !== UNSURE && (
        <label className="flex flex-col gap-1 text-sm text-mute">
          {t.note}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder={t.placeholder} className="rounded-lg border border-line bg-night px-3 py-2 text-ink" />
        </label>
      )}

      <label className="flex items-start gap-3 text-sm text-pretty text-mute">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" data-testid="donate-consent" />
        <span>{t.consent}</span>
      </label>

      {state.kind === "error" && <p className="text-sm text-pretty text-red-300">{t.failed} {state.message}</p>}

      <div>
        <button type="submit" disabled={!consent || state.kind === "sending"} className="rounded-full bg-amber px-6 py-3 font-medium text-night transition hover:bg-amber-soft disabled:opacity-40" data-testid="donate-send">
          {state.kind === "sending" ? t.sending : t.give}
        </button>
      </div>
    </form>
  );
}
