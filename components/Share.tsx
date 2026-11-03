"use client";

import { useState } from "react";
import { drawCard, type Card } from "@/lib/client/card";

const SITE = "https://unheard.gwendall.com";

/** Shares the card through the phone's share sheet; on a computer, saves it and copies the text. */
export function Share({ card, text }: { card: Card; text: string }) {
  const [state, setState] = useState<"idle" | "busy" | "saved" | "error">("idle");

  async function share() {
    setState("busy");
    try {
      await document.fonts.ready;
      const blob = await drawCard(card, getComputedStyle(document.body).fontFamily);
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
        {state === "busy" ? "Making the picture..." : "Share what your phone heard"}
      </button>
      {state === "saved" && <p className="text-sm text-pretty text-mute">The picture is saved and the text copied: paste them where you like.</p>}
      {state === "error" && <p className="text-sm text-pretty text-red-300">Could not make the picture on this browser.</p>}
    </div>
  );
}
