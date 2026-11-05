# Unheard

One source for every agent: Codex reads this file, Claude Code reads it through `CLAUDE.md`,
which only holds `@AGENTS.md`. Project rules go here, never in `CLAUDE.md`.

Read `docs/STATUS.md` first: where the app is, what is in flight, what needs the founder.
Next.js rules: the generated block at the end of this file.

- `lib/core/` is the physics and the matcher: no DOM, no React (eslint enforces it). It runs in
  the page, in vitest and in the evals.
- `analyze()` in `lib/core/pipeline.ts` is the only analysis path. Evals and the page call it;
  never fork a second pipeline for a test.
- Any change to `lib/core` or `lib/adsb.ts` reruns `pnpm eval evals/synthetic` and
  `pnpm eval evals/real-tracks` (CI does), and `pnpm eval evals/real-audio` locally when the
  cache is there. Thresholds (`STRONG`, `POSSIBLE`) change only with the calibration lines of a
  report quoted in the commit. "Strong" must never be wrong.
- Data licenses: AeroSonicDB (NC) and ADS-B Exchange samples never enter git (`evals/.cache/`).
  adsb.lol (ODbL) fixtures may.
- adsb.lol rate-limits at about one request every 2 s per address: never run two recorders, and
  the API route must stay cached.
- Dev servers through `machine serve` only; Playwright closes its browser (see the global rules).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
