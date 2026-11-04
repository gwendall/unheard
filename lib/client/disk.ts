// What the check keeps for a moment on this device, in the browser's private files (OPFS), so a long
// file never has to sit in memory: its sound at the analysis rate, and the cleaned file being
// written. Where private files are not to be had (a private window in some browsers, too little
// room), memory does the same job and a long file costs more of it.

import { memoryStore, type SoundStore } from "../core/stream";
import { checkFolder } from "./folder";

/** Only in a worker, and not in TypeScript's DOM lib. */
type SyncHandle = {
  read(bytes: Uint8Array, options: { at: number }): number;
  write(bytes: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
};
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };

async function open(folder: string, name: string): Promise<{ file: SyncFile; access: SyncHandle } | null> {
  try {
    const root = await checkFolder();
    if (!root || typeof (FileSystemFileHandle.prototype as Partial<SyncFile>).createSyncAccessHandle !== "function") return null;
    const dir = await root.getDirectoryHandle(folder, { create: true });
    const file = (await dir.getFileHandle(name, { create: true })) as SyncFile;
    return { file, access: await file.createSyncAccessHandle() };
  } catch {
    return null;
  }
}

const bytesOf = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** The sound at the analysis rate: on disk when it can be, in memory when not. */
export async function openStore(folder: string, name = "sound.f32"): Promise<SoundStore> {
  const opened = await open(folder, name);
  if (!opened) return memoryStore();
  const { access } = opened;
  return {
    read(start, count) {
      const out = new Float32Array(count);
      access.read(bytesOf(out), { at: start * 4 });
      return out;
    },
    write(start, samples) {
      access.write(bytesOf(samples), { at: start * 4 });
    },
  };
}

/** Bytes at positions in, a file out at the end. */
export type Sink = {
  write(data: Uint8Array, position: number): void;
  /** The whole file, ready to download. */
  finish(type: string): Promise<Blob>;
};

const MEMORY_PART = 1 << 24;

/** A sink in Blobs, which the browser may keep out of the page's memory. Later writes win. */
export function memorySink(): Sink {
  const parts: { at: number; blob: Blob }[] = [];
  let run: Uint8Array[] = [];
  let runAt = 0;
  let runSize = 0;
  const flush = () => {
    if (runSize) parts.push({ at: runAt, blob: new Blob(run as BlobPart[]) });
    run = [];
    runSize = 0;
  };
  return {
    write(data, position) {
      if (position !== runAt + runSize || runSize >= MEMORY_PART) {
        flush();
        runAt = position;
      }
      run.push(data.slice());
      runSize += data.length;
    },
    async finish(type) {
      flush();
      const size = parts.reduce((n, p) => Math.max(n, p.at + p.blob.size), 0);
      // From the last write back: what is left of each part once the later ones have had their say.
      const pieces: { at: number; blob: Blob }[] = [];
      let free = [{ start: 0, end: size }];
      for (const p of [...parts].reverse()) {
        const end = p.at + p.blob.size;
        const next: typeof free = [];
        for (const f of free) {
          const a = Math.max(f.start, p.at);
          const b = Math.min(f.end, end);
          if (a >= b) {
            next.push(f);
            continue;
          }
          pieces.push({ at: a, blob: p.blob.slice(a - p.at, b - p.at) });
          if (f.start < a) next.push({ start: f.start, end: a });
          if (b < f.end) next.push({ start: b, end: f.end });
        }
        free = next;
      }
      return new Blob(pieces.sort((x, y) => x.at - y.at).map((p) => p.blob), { type });
    },
  };
}

/** A sink on disk when there is room for about `size` bytes, in memory when not. */
export async function openSink(folder: string, name: string, size: number): Promise<Sink> {
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const room = estimate?.quota !== undefined && estimate.usage !== undefined ? estimate.quota - estimate.usage : Infinity;
  const opened = room > 1.2 * size ? await open(folder, name) : null;
  if (!opened) return memorySink();
  const { file, access } = opened;
  return {
    write(data, position) {
      access.write(data, { at: position });
    },
    async finish(type) {
      access.flush();
      access.close();
      const written = await file.getFile();
      return written.slice(0, written.size, type);
    },
  };
}
