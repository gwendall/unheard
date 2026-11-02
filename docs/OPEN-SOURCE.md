# Open source plan

Unheard is meant to become an open project: anyone can record, label, measure and improve, and
every improvement shows as a number. This page holds the plan, the checklist for the day the
repository goes public, and the design of the listening station.

## Why it suits open source

- The problem is measurable: for every recording there is a right answer (the aircraft overhead,
  known from ADS-B), so a contribution is judged by a number, not an opinion.
- The bench already exists: three evals through the production `analyze()`, a ratchet in
  `evals/baseline.json`, a workflow that moves to GitHub's runners once the repository is public.
- A community is already there: ADS-B hobbyists (adsb.lol, readsb, tar1090 are open source and
  fed by volunteers), plane spotters, physics teachers.

## Phases

### Phase 0: private

- A protected preview deployment, so the page can be opened on a phone (the microphone needs
  HTTPS).
- 20 to 30 real phone recordings of flybys by the founder: a light-aircraft field, a heliport, an
  approach path. The first phone data, and the answer to whether a phone is enough.
- The donate flow: consent, anonymisation on the phone, upload.
- Benchmark v1 frozen: the recordings and tracks it holds, its metrics, its version number.

### Phase 1: opening

- The checklist below, done in order, then the repository goes public.
- Scoreboard in the README, regenerated from the evals; each pull request gets its eval delta.
- Starter issues from the "Next" list of `docs/STATUS.md`.

### Phase 2: scale

- The listening station (below).
- A hidden test set, held by the maintainers and run on merge, so the public set cannot be
  overfitted.
- A public ranking of matchers on the benchmark.
- Talk to adsb.lol: an API key for the page's traffic, and a mention to their feeders, who are
  the station's natural builders.

## Go-public checklist

Do these in order. The first one is a security issue, not a formality.

1. **Uninstall the local-ci runners first.** While the repository is private its CI runs on this
   Mac. On a public repository a pull request from a fork can edit `runs-on` back to
   `self-hosted` and run its code on the Mac. Before changing the visibility, from kit's
   `scripts/ci/`: `local-runner.sh uninstall gwendall/unheard` (stops, deregisters, removes the
   LaunchAgents), check that `gh api repos/gwendall/unheard/actions/runners` lists none, and
   remove the unheard line from `CARTE.md` in `~/code/machine`.
2. **Actions settings:** "Require approval for all outside collaborators" for workflows from
   forks. No repository secrets the CI does not need.
3. **The workflow lands on GitHub's runners:** `.github/workflows/ci.yml` picks `ubuntu-latest`
   when `github.event.repository.private` is false. Watch the first public run do so.
4. **Secret scan of the whole history** with gitleaks or trufflehog. Nothing of the Vercel Blob
   token or any other credential may be in git, and the Blob token never reaches CI.
5. **Code of Conduct contact:** set the reporting address in `CODE_OF_CONDUCT.md`.
6. **Data licenses:** confirm how CC BY 4.0 recordings combine with the ODbL adsb.lol positions
   they carry; check that `evals/.cache/` content (AeroSonicDB, ADS-B Exchange) has never been
   committed (`git log --all -- evals/.cache` is empty).
7. **Docs scrub:** read `README.md`, `CONTRIBUTING.md`, `docs/` and `evals/` as a stranger.
   Machine-specific notes for agents (`CLAUDE.md`, `AGENTS.md`) may stay. The "Needs the founder"
   list in `docs/STATUS.md` is fine to keep.
8. **Change the visibility**, then open the starter issues.

## The listening station

A Raspberry Pi that already feeds ADS-B (a receiver, an antenna, a known position) plus a USB
microphone: a few euros more for a feeder.

- **What it records:** the microphone continuously, into a rolling buffer in memory. Nothing is
  kept by default.
- **Labelling itself:** the station's own ADS-B receiver sees every aircraft within range. When
  one passes within a few kilometres, the station keeps the audio from a minute before its
  closest point to a minute after, with the aircraft's track from its own receiver. It also keeps
  quiet windows with no aircraft within 20 km: the "nothing to find" cases. Truth comes from
  ADS-B, with no human labelling.
- **What it uploads:** only those passes and quiet windows, anonymised the same way as donated
  recordings (the station at the origin of a local frame, no latitude or longitude, no absolute
  time, no aircraft identifier, type kept).
- **Privacy:** a microphone on a roof hears the street. Passes with speech are dropped on the
  station before upload (voice activity detection), the owner can review and veto any upload,
  and the station's documentation says so in plain words.
- **Why it matters:** a hundred stations give more labelled flyby audio in a week than every
  public dataset together, in every weather, with exact positions.
