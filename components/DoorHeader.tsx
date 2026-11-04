// The heading above the file's door, the same on the home and on /where, so moving between them
// moves nothing. With a file in, the lead has done its work: what the file gives comes up.

export function DoorHeader({ title, lead, note }: { title: string; lead?: string; note: string }) {
  return (
    <header className="flex flex-col gap-4">
      <h1 className="text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl">{title}</h1>
      {lead && (
        <p className="max-w-prose text-lg text-pretty text-mute" data-testid="where-lead">
          {lead}
        </p>
      )}
      <p className="flex items-baseline gap-3 text-pretty text-ink" data-testid="where-private">
        <span aria-hidden className="size-1.5 shrink-0 translate-y-[-0.15em] rounded-full bg-amber/70" />
        {note}
      </p>
    </header>
  );
}
