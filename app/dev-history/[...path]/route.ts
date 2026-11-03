import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// The flight tiles in development, from a local folder (e2e/history, the end-to-end test's small
// fixture, or DEV_HISTORY_DIR for a real day, evals/.cache/history): .env.development points
// NEXT_PUBLIC_HISTORY_URL here. Nothing in production.

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (process.env.NODE_ENV !== "development") return new Response(null, { status: 404 });
  const root = resolve(process.env.DEV_HISTORY_DIR ?? join(process.cwd(), "e2e/history"));
  const file = resolve(root, ...(await params).path);
  if (!file.startsWith(root + sep)) return new Response(null, { status: 404 });
  try {
    const bytes = new Uint8Array(await readFile(file));
    return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
  } catch {
    return new Response(null, { status: 404 });
  }
}
