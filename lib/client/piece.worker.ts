// One worker of the pool (lib/client/pool.ts): a piece of the work at a time, with what it is
// given and nothing else. Its answers are handed over, not copied.

import { shapeOf, stretchOf, type Shape, type Stretch } from "../core/flyby";
import { findChunk, takeOutOf, type ChunkFound, type ChunkOptions, type TakeOutJob } from "../core/leak";
import { scanPart, type Path, type ScanOptions, type ScanPart, type Tone as ScanTone } from "../core/tracks";
import type { Piece, PieceReply } from "./pool";

export type PieceInput =
  | { do: "chunk"; samples: Float32Array; start: number; rate: number; options: ChunkOptions }
  | { do: "takeOut"; job: TakeOutJob }
  | { do: "stretch"; samples: Float32Array; rate: number }
  | { do: "shape"; t: Float64Array; y: Float64Array; c: number }
  | { do: "scan"; tones: ScanTone[]; paths: Path[]; jets: Uint8Array; options: Omit<ScanOptions, "onProgress">; longest: number };

export type PieceOutput = ChunkFound | Float32Array[] | Stretch | Shape | ScanPart;

// The worker's own global, typed by what this file uses of it (the DOM and webworker libs clash).
const scope = self as unknown as { postMessage: (reply: PieceReply<PieceOutput>, transfer?: Transferable[]) => void; onmessage: ((e: MessageEvent<Piece<PieceInput>>) => void) | null };

/** Every buffer in an answer, once: they are handed over, and a stack's layers share some. */
function buffersIn(value: unknown, found = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (ArrayBuffer.isView(value)) found.add(value.buffer as ArrayBuffer);
  else if (Array.isArray(value)) for (const item of value) buffersIn(item, found);
  else if (value && typeof value === "object") for (const item of Object.values(value)) buffersIn(item, found);
  return [...found];
}

async function work(input: PieceInput, onShare: (share: number) => void): Promise<PieceOutput> {
  switch (input.do) {
    case "chunk":
      return findChunk(input.samples, input.start, input.rate, input.options, onShare);
    case "takeOut":
      return takeOutOf(input.job, onShare);
    case "stretch":
      return stretchOf(input.samples, input.rate, onShare);
    case "shape":
      return shapeOf(input.t, input.y, input.c);
    case "scan":
      return scanPart(input.tones, input.paths, input.jets, { ...input.options, onProgress: (done, total) => onShare(done / total) }, input.longest);
  }
}

scope.onmessage = ({ data: { id, input } }) => {
  work(input, (share) => scope.postMessage({ id, share })).then(
    (out) => scope.postMessage({ id, out }, buffersIn(out)),
    (err: unknown) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
};
