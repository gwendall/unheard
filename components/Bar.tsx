/** How far a whole job has got, 0 to 1. It only ever moves on: the worker's estimate never goes back. */
export function Bar({ fraction, label, testid }: { fraction: number; label: string; testid?: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} className="h-1 w-full overflow-hidden rounded-full bg-line" data-testid={testid}>
      <div className="h-full origin-left rounded-full bg-amber transition-transform duration-500 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${fraction})` }} />
    </div>
  );
}
