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
- The place rule (`namesAPlace` in `lib/client/where.ts`, #94) is frozen: it changes only with a
  new held-out test, reported as it comes. Every condition picked after seeing results spends it.
- A private recording's exact place (Livermore's fitted microphone position) never enters the
  repo, a page or a demo: report distances only. colsto's audio never enters git.
- Never load-test adsb.lol or production. Secrets (Vercel, Fly, Tigris) are never printed or
  committed. No self-hosted runner: this repository is public.

## Proof

- Unit: `pnpm lint`, `pnpm typecheck`, `pnpm test`. Evals in git: `pnpm eval evals/synthetic`,
  `pnpm eval evals/real-tracks`. Evals on data that stays off git (AeroSonicDB, Livermore,
  colsto, the wide search) need `evals/.cache/` (`evals/README.md`). E2E: `pnpm e2e`.
- CI (`.github/workflows/ci.yml`: `check`, `eval`, `e2e`) runs on every pull request; that run
  is the proof, do not run it again locally. Merge green, at the head CI checked:
  `gh pr merge <n> --squash --match-head-commit <sha>`.
- What visitors see gets one check in production once deployed (https://unheard.gwendall.com,
  production follows `main`). The archive: `days.json` at
  https://unheard-history.t3.tigrisbucket.io/ lists yesterday after the 06:17 UTC job.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
