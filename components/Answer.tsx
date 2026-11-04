"use client";

import { createContext, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";

// One answer, whatever the file: a map or the place where one would be, one sentence, one date, what
// to do next, and the rest folded. The check while it works, a file that says where it was made, a
// place named from its planes and "we cannot tell" all take this shape, and the sentence's and the
// reason's boxes hold their height: what sits under them stays under the visitor's finger when one
// state gives way to the next.

const QUIET = "text-mute underline-offset-4 transition hover:text-ink hover:underline";

/** Where a map's credits go: at the foot of the answer, so that its sentence comes right under the map. */
export const CreditSlot = createContext<HTMLElement | null>(null);

/** What opens is drawn the first time it is opened, then kept: a search open in it keeps its state. */
function Details({ summary, onToggle, children }: { summary: string; onToggle?: (open: boolean) => void; children: ReactNode }) {
  const [seen, setSeen] = useState(false);
  return (
    <details
      data-testid="answer-details"
      onToggle={(e) => {
        const { open } = e.currentTarget;
        if (open) setSeen(true);
        onToggle?.(open);
      }}
    >
      <summary className={`${QUIET} w-fit cursor-pointer`}>{summary}</summary>
      {seen && <div className="mt-6 flex flex-col gap-8">{children}</div>}
    </details>
  );
}

export type AnswerProps = {
  /** The map; with none, the place where one would be. */
  map?: ReactNode;
  title: string;
  titleProps?: HTMLAttributes<HTMLHeadingElement> & { "data-testid"?: string };
  titleRef?: Ref<HTMLHeadingElement>;
  when?: string | null;
  why?: ReactNode;
  rows?: ReactNode;
  actions?: ReactNode;
  quiet?: ReactNode;
  after?: ReactNode;
  /** Credits, under everything. */
  foot?: ReactNode;
  summary: string;
  details: ReactNode;
  onDetails?: (open: boolean) => void;
};

export function Answer({
  map,
  title,
  titleProps,
  titleRef,
  when,
  why,
  rows,
  actions,
  quiet,
  after,
  foot,
  summary,
  details,
  onDetails,
}: AnswerProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="flex flex-col gap-6" data-testid="answer">
      <CreditSlot.Provider value={slot}>
        {map ?? (
          <div aria-hidden className="flex h-30 items-center justify-center rounded-2xl border border-line bg-deep text-4xl text-faint" data-testid="answer-no-map">
            ?
          </div>
        )}
      </CreditSlot.Provider>
      <div className="flex flex-col gap-2">
        <h2 ref={titleRef} tabIndex={-1} className="min-h-18 scroll-mt-4 text-3xl font-semibold tracking-tight text-balance outline-none sm:min-h-10 sm:text-4xl" {...titleProps}>
          {title}
        </h2>
        {when && (
          <p className="text-lg text-pretty text-ink tabular-nums" data-testid="answer-when">
            {when}
          </p>
        )}
        <div className="flex min-h-24 flex-col justify-center text-lg text-pretty text-mute sm:min-h-14" data-testid="answer-why">
          {why}
        </div>
      </div>
      {rows}
      <div className="flex min-h-30 flex-col gap-3 sm:min-h-13.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4" data-testid="answer-actions">
        {actions}
      </div>
      {quiet && <div className="flex flex-col items-start gap-4">{quiet}</div>}
      {after}
      <Details summary={summary} onToggle={onDetails}>
        {details}
      </Details>
      <div ref={setSlot} className="flex flex-col gap-2 empty:hidden">
        {foot}
      </div>
    </div>
  );
}
