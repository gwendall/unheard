"use client";

import { useState } from "react";
import { drawCard, type Card } from "@/lib/client/card";
import { useI18n } from "@/components/I18n";

const SITE = "https://unheard.gwendall.com";

/** Shares the card through the phone's share sheet; on a computer, saves it and copies the text. */
export function Share({ card, text, label }: { card: Card | (() => Promise<Card>); text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "saved" | "error">("idle");
  const t = useI18n().m.share;

  async function share() {
    setState("busy");
    try {
      await document.fonts.ready;
      const blob = await drawCard(typeof card === "function" ? await card() : card, getComputedStyle(document.body).fontFamily);
      const file = new File([blob], "unheard.png", { type: "image/png" });
      const message = `${text} ${SITE}`;
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: message });
        setState("idle");
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "unheard.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      await navigator.clipboard?.writeText(message).catch(() => {});
      setState("saved");
    } catch (error) {
      setState((error as Error).name === "AbortError" ? "idle" : "error");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => void share()} disabled={state === "busy"} className="rounded-full bg-amber px-6 py-3 font-medium text-night transition enabled:hover:bg-amber-soft disabled:opacity-60" data-testid="share">
        {state === "busy" ? t.busy : (label ?? t.button)}
      </button>
      {state === "saved" && <p className="text-sm text-pretty text-mute">{t.saved}</p>}
      {state === "error" && <p className="text-sm text-pretty text-red-300">{t.error}</p>}
    </div>
  );
}
