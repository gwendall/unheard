// The copy without its tags, off the page's thread and apart from the check: it reads packets and
// writes them (lib/client/remux.ts), and analyses nothing. So it needs no tone found and no sound,
// and it runs whether the check is working, has stopped for a search, or never had anything to do.
// The file stays on this device.

import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { openSink } from "./disk";
import { planCopy, writeCopy } from "./remux";

export type StripRequest = { file: File; folder: string };

export type StripEvent = { type: "progress"; fraction: number } | { type: "done"; file: Blob; extension: string } | { type: "failed" };

// The worker's own global, typed by what this file uses of it (the DOM and webworker libs clash).
const scope = self as unknown as { postMessage: (event: StripEvent) => void; onmessage: ((e: MessageEvent<StripRequest>) => void) | null };

async function copy({ file, folder }: StripRequest) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const plan = await planCopy(input);
    if (!plan) return scope.postMessage({ type: "failed" });
    const sink = await openSink(folder, `copy.${plan.extension}`, file.size);
    let shown = -1;
    const written = await writeCopy(plan, sink, (fraction) => {
      const at = Math.round(100 * fraction);
      if (at === shown) return;
      shown = at;
      scope.postMessage({ type: "progress", fraction });
    });
    scope.postMessage({ type: "done", file: written, extension: plan.extension });
  } finally {
    input.dispose();
  }
}

scope.onmessage = (e) => {
  copy(e.data).catch(() => scope.postMessage({ type: "failed" }));
};
