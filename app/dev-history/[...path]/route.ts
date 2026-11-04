import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// The flight tiles in development, from a local folder (e2e/history, the end-to-end test's small
// fixture, or DEV_HISTORY_DIR for a real day, evals/.cache/history): .env.development points
// NEXT_PUBLIC_HISTORY_URL here. Nothing in production. It answers ranges as the bucket does: the
// ground's height is read that way.

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (process.env.NODE_ENV !== "development") return new Response(null, { status: 404 });
  const root = resolve(process.env.DEV_HISTORY_DIR ?? join(process.cwd(), "e2e/history"));
  const file = resolve(root, ...(await params).path);
  if (!file.startsWith(root + sep)) return new Response(null, { status: 404 });
  try {
    const bytes = new Uint8Array(await readFile(file));
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (!range) return new Response(bytes, { headers: { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes" } });
    const start = Number(range[1]);
    const end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1);
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes.length}` } });
    return new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": String(end - start + 1) },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
