// Where the check keeps its files on this device (the browser's private files), and how they go:
// removed when the visitor moves on, and swept on a later visit if a tab died first. Nothing here is
// ever sent. Apart from lib/client/disk.ts so the page can clear up without loading the analysis.

const ROOT = "unheard-check";
const DAY = 86_400_000;

/** A place for one file's check, named so that a later visit can tell its age. */
export const newFolder = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export async function checkFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
  } catch {
    return null;
  }
}

/** Removes one check's files. Its worker may take a moment to let go of them. */
export async function forget(folder: string, tries = 5): Promise<void> {
  const root = await checkFolder();
  for (let i = 0; root && i < tries; i++) {
    try {
      await root.removeEntry(folder, { recursive: true });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** What a tab that died left behind. A day old, so never what another tab is using. */
export async function sweep(): Promise<void> {
  const root = await checkFolder();
  if (!root) return;
  const names: string[] = [];
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
  await Promise.all(names.filter((name) => Date.now() - Number(name.split("-")[0]) > DAY).map((name) => forget(name, 1)));
}
