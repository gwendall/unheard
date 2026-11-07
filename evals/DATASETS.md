# Real data for the Doppler-match eval

What the eval needs from each recording: (1) UTC start time to about 1 s, (2) microphone lat/lon, (3) aircraft passes in the audio, ideally props or helicopters at low altitude, (4) the ADS-B tracks, or a way to fetch them for that time and place.

Surveyed 2026-11-02. Fields below were checked against the published metadata files, not only the papers. Downloads for the checks: about 85 MB in total, kept outside the repo.

## Audio sources

### AeroSonicDB (YPAD-0523), Adelaide

- Paper: Downward and Nordby 2023, https://arxiv.org/abs/2311.06368. Code: https://github.com/aerosonicdb/AeroSonicDB-YPAD0523 (MIT, code only).
- Versions (Zenodo concept record 8000468):
  - **1.1.2, Nov 2023, latest open version**: https://zenodo.org/records/10215080. License **CC BY-NC 4.0**. `audio.zip` 1.17 GB (1,895 WAV, 22,050 Hz mono 16-bit), `env_audio.zip` 495 MB (six 1 h continuous recordings), small CSV/JSON metadata.
  - 0.3, Jun 2023: https://zenodo.org/records/8004108. License CC BY 4.0 (the only non-NC version), but clips were trimmed to "the best 20 s", so the filename time no longer marks the clip start. Not useful for timing.
  - **2.0-beta "AeroSonicDB 3K", Jul 2024**: https://zenodo.org/records/12775560. **Restricted**: request access on Zenodo, by email (aerosonicdb@gmail.com) or Google Form. 3,058 aircraft events (38 h: piston 1.2 h, turboprop 5.3 h, turbofan 31 h, rotorcraft 0.5 h), 16 kHz, same filename convention, clips trimmed to audible onset/offset (so the filename time is no longer the clip start; offset unknown), `altitude` column dropped. Zenodo says CC BY-NC-SA 4.0, the description says CC BY-NC 4.0.
- Files and exact fields (v1.1.2):
  - Filename `{hex_id}_{YYYY-MM-DD}_{hh-mm-ss}_{location}_{mic}.wav`, e.g. `7C77D9_2023-03-01_13-29-31_1_1.wav`. Zip path `audio/1/<file>` (aircraft) or `audio/0/<file>` (silence).
  - `sample_meta.csv`: `train-test,fold,filename,date,time,location,mic,class,subclass,altitude,hex_id,session,offset,duration,file_length,reg,airframe,engtype,engnum,shortdesc,typedesig,manu,model,engmanu,engmodel,engfamily,fueltype,propmanu,propmodel,mtow`. `offset`/`duration` = audible event inside the file (s), `altitude` = last ADS-B altitude (ft) at trigger.
  - `aircraft_meta.csv`: `hex_id,reg,airframe,engtype,engnum,shortdesc,typedesig,manu,model,engmanu,engmodel,engfamily,fueltype,propmanu,propmodel,mtow` (propeller model gives blade count, e.g. Hartzell HC-D4N-3A = 4 blades).
  - `locations.json`: `{"0": {"lattitude": -34.85364, "longitude": 138.67517}, "1": {-34.96092, 138.51311}, "2": {-34.96428, 138.51011}}` (sic "lattitude"). These are a public spot near the recorder, not the exact mic position (privacy); the error looks like tens to a few hundred metres.
- **Time**: 1 s precision, **local Adelaide time, not UTC** (README does not say so). Verified on all 9 clips of 2023-03-01 against ADS-B Exchange traces: UTC = filename time minus 10:30 (ACDT), the aircraft enters the 1 km trigger radius 3 s before to 13 s after the clip start, closest approach falls 9 to 25 s after start for the runway-aligned passes. After 2023-04-02 Adelaide is on ACST (UTC+9:30); that conversion is assumed, not verified. Treat the start as known to a few seconds and let the matcher fit a small offset.
- No track, no distance in the dataset: only the hex, so ADS-B must be fetched separately.
- Content: 625 aircraft clips (18 to 60 s; 603 are 60 s) from 2022-12-08 to 2023-05-23. Subclasses: 36 piston, 114 turboprop, 470 turbofan, 5 rotorcraft. Location 0 (15.5 km NE of the runway, about 3,000 ft, 3 km trigger) holds 140 of the 150 piston/turboprop clips; locations 1 and 2 (500 to 950 m off the runway end, low and loud, windy) hold 31 clips.
- `env_audio.zip` (495 MB): six recordings of one hour each, 22,050 Hz mono, labelled in `environment_class_mappings.csv` (one column per file, 0-based column for the file `<column + 1>_AUDIO.wav`, checked against each file's loudness), a row per 5 s: 0 no aircraft, 1 aircraft, `ignore` the edges of an event. Human-verified "no aircraft audible", so a far plane under a human's hearing can hide in a 0. Used by the `ghost` eval as real sound with nothing to find. No flight data for those days.
- **Fit: yes**, for a first real eval: second-level timestamps, a mic position, real prop and helicopter passes. Limits: non-commercial license, approximate mic position, local-time trap, ADS-B only freely available for 2023-03-01 (see below).

### Livermore (Pathak 2026), California - 40 phone recordings with their tracks

- Zenodo record 23424278, "Aeroplane data full analysis and raw files", 2026-10-16: https://zenodo.org/records/23424278. License **CC BY 4.0**. Accompanies the paper "Aircraft speed and height from Doppler-shifted sound and flight-track data" (Pathak 2026).
- **Attribution**: Praveen Pathak, "Aeroplane data full analysis and raw files", Zenodo, 2026, https://doi.org/10.5281/zenodo.23424278, CC BY 4.0.
- Fetch: `node scripts/fetch-livermore.ts` downloads the four `Raw data_*.zip` (23, 79, 10 and 21 MB) and `final_results_40_cases.csv` into `evals/.cache/livermore/downloads/`, checks each against the size and MD5 the Zenodo API gives, unpacks each zip into its own directory under `extracted/` (member paths that leave it are refused), and gets the hourly temperature of those days from Open-Meteo. The audio stays in `evals/.cache/` and never enters git: the license would allow it with the attribution above, but 130 MB of WAV has no place in the repository.
- Per passage, `<category>/<registration>_R<nn>/`:
  - `audio.wav`: 48 kHz mono 16-bit, 41 to 182 s, no metadata chunk.
  - `frequency_vs_time_used.csv`: `time_utc,frequency_hz`, the author's ridge of one harmonic, a point every 0.17 s or so. UTC: the author's tool takes the recording's start from the phone's file name (to 1 s).
  - `<registration>-track-EGM96.kml`: a `gx:Track` of the whole flight, `<when >` UTC and `<gx:coord >lon lat alt`, altitude in metres MSL (ADS-B geometric altitude brought to EGM96), `altitudeMode` absolute, ground points at 0. Positions only, a point every 3 to 20 s near the pass.
  - `result_page.pdf`: the paper's page for that passage.
- `final_results_40_cases.csv`: `case, category, received_start_utc, track_file, altitude_basis, L_ADSB_m` (horizontal distance from the recorder to the ADS-B ground track at closest approach), `H_ADSB_above_recorder_m, R_ADSB_m, V_ADSB_*, timing_difference_s` (not documented), the two methods' results (`MI_*`, `MII_*`) and `flags`. Categories: speed and height each constant or varying.
- Aircraft are named by registration only (US N-numbers); the ICAO address follows from it (`nNumberToIcao` in `evals/lib/livermore.ts`, checked against adsbdb.com). Mostly light aircraft (Cessna 172, PA-28, TBM 930, an R44 helicopter), a few jets (Challenger 350, EMB-145) up to 5.7 km above; slant distance at closest approach 0.3 to 5.7 km.
- Traps, and what `evals/lib/livermore.ts` does about them:
  - **No microphone position.** Recovered from L: the one point whose horizontal distance to each track matches its L. 37 passages agree on one site to 2 m rms; the three of 2026-05-09 agree to 1 m on a second site about 6.6 km away. That is the position the author computed L from; the phone may be a few metres off it. The coordinates are not written in this repository (one of them may be a private address): the eval computes them from the cache. The recorder's height is the track's altitude at the pass minus H, MSL like the tracks.
  - **No audio start time.** Sliding the UTC ridge over the recording's own spectrogram gives the first sample's time to about 0.1 s (34 of the 40 files are the ridge plus 5 s on each side). The phone clock's error, about a second, stays.
  - **No velocities.** Ground speed, heading and climb come from the KML points at least 4 s away on each side; the page gets the broadcast velocity instead.
  - **One aircraft per recording.** The set has no other traffic. The eval puts every other passage's aircraft flying within 40 km at the time into a recording's data (0 to 5 of them) and runs each recording again without its own aircraft. In R21 the Cessna 172 of R22 passes 1.1 km away and is audible too (`LIVERMORE_ALSO_AUDIBLE` in `evals/lib/real.ts`). The airport's other traffic is unknown: a day of adsb.lol `globe_history` (about 3 GB) would add it.
- Also used by dopplerprint (https://github.com/Hexay/dopplerprint, MIT) to locate the recorder from the sound: right aircraft in 34/40, median error 207 m, with the start time known to 2 s. Its corpus builder (`tools/corpus/livermore.py`) recovers the recorder from L and aligns the ridge the same way.
- **Fit: yes.** Real phone audio of light aircraft and jets from 0.3 to 6 km, exact tracks, open license. Limits: the microphone position is the author's, the clock is a file name, no background traffic.

### Other aircraft-audio sets

| Source | URL, license, size | Time / location / aircraft id | Fit |
|---|---|---|---|
| AeroLoop baseline (same Adelaide hex_date naming, Edge Impulse contest) | https://zenodo.org/records/17765718, MIT, 4 zips of 15 MB | `labels.csv`: `filename,class,duration,sample_rate,dtype,split`; filename `7C2BB0_2025-10-31_09-50.wav` = hex + local time **to the minute**; no location | No: minute precision, no mic position. Could become usable if the author shares seconds and location (2025 dates are inside adsb.lol coverage). |
| Isherwood and Newbury, "Autonomous aircraft noise recording" (Sussex, Forum Acusticum 2026) | https://dael.euracoustics.org/confs/fa2026/data/articles/000004.pdf | Noise monitor with its own ADS-B receiver: UTC, hex, positions, 48 kHz MP3 per event | No for now: **data not released**. Worth an email (g.isherwood@sussex.ac.uk): it is exactly our format, in the UK. |
| Zhang et al. 2023, JASA 153(5):3138, SMU Dallas, acoustic sensor + co-located ADS-B | https://doi.org/10.1121/10.0019594 | Paired audio and ADS-B | No: no public data found. |
| Risoux forest soundscape (Jura) | https://zenodo.org/records/10701274, CC BY-SA 4.0, 10.5 GB | SongMeter files named `S4A03536_20180801_123000.wav` (local start to 1 s), 4 recorders about 1 km apart, `plane` 0/1 label, no hex | No: mostly high-altitude jets, 2018 (before adsb.lol), no ids. |
| SONYC-UST v2 (NYC) | https://zenodo.org/records/3966543, CC BY 4.0 | Aircraft tag, but time quantized to the **hour**, location to the city block | No. |
| NoiseCapture (phones, data.noise-planet.org) | ODbL | UTC epoch per second, GPS, but only 1 s LAeq and third-octave spectra, **no audio** | No: third-octave bands cannot track a blade-pass tone. |
| TartanAviation (Pittsburgh KAGC/KBTP) | https://arxiv.org/abs/2403.03372 | Images, ATC radio speech, 661 days of ADS-B | No: no ambient microphone audio. Its ADS-B has no matching recordings. |
| ESC-50, FSD50K, AudioSet, DCASE (airplane/helicopter classes) | various CC | No time, no location | No. |
| Airport noise monitoring (WebTrak, NOMOS, Envirosuite portals) | portal terms | Per-event LAmax/SEL with a correlated track, no audio published | No. |

## ADS-B sources

All three serve the same readsb "trace" JSON (https://github.com/wiedehopf/readsb/blob/dev/README-json.md#trace-jsons), gzip-compressed even without a `.gz` name: `{icao, r, t, desc, timestamp, trace: [[dt_s, lat, lon, alt_baro_ft|"ground", gs_kt, track_deg, flags, vrate_fpm, aircraft_obj|null, source, alt_geom_ft, geom_rate, ias, roll], ...]}`. Absolute UTC time of a point = `timestamp + dt_s`; files cover one UTC day.

### adsb.lol globe_history (GitHub releases)

- Repos: https://github.com/adsblol/globe_history_2023 (from 2023-03-11), `_2024`, `_2025`, `_2026` (daily, latest 2026-11-01). License **ODbL 1.0** (attribution, share-alike on derived databases); feeders' data CC0.
- One release per UTC day and per pod (`prod-0`, `prod-1`, `staging-0`, plus `mlatonly` since 2024). Pick prod, unless much smaller than staging.
- Size per day: 2023 about 1.1 to 1.8 GB (one `.tar`); 2024 about 2.1 GB, 2025 to 2026 about 3.1 to 3.2 GB (split `.tar.aa` 2.0 GB + `.tar.ab`). The 2026 repo is 1,976 GiB.
- Layout: `./traces/<last 2 hex digits>/trace_full_<hex>.json` (plus `./heatmap/` for replay). Normal trace resolution near the ground: one point every 2 to 8 s.
- Extract one aircraft for a day: `cat v2025.05.18-planes-readsb-prod-0.tar.aa v2025.05.18-planes-readsb-prod-0.tar.ab | tar -xf - ./traces/d9/trace_full_7c77d9.json` then `gunzip -c`. That still downloads the whole day. Cheaper: GitHub serves HTTP ranges, and each `traces/XX/` directory is contiguous in the tar (directory order is not sorted), so probing 400 offsets then fetching only the directory's span pulled one trace with **18.8 MB of requests out of 1.1 GB** (tested; small script, not committed).
- Coverage caveat, tested: on 2023-04-06 and 2023-05-09 adsb.lol had **no Adelaide receiver** (a Qantas 737 is traced at Perth, Melbourne and Sydney only; the AeroSonicDB R44 and DA42 are absent). So adsb.lol cannot back the 2023 AeroSonicDB clips. Check coverage near any new site before relying on it.
- **Fit: yes** as the default history source for our own recordings (open license, any day since 2023-03-11), not for AeroSonicDB.
- **Attribution**: "© adsb.lol contributors", ODbL 1.0. Anything built from it (our history tiles included) is a derived database under the same licence.
- Which 2026 days exist (checked 2026-11-03): every `prod-0` release asked for, `v2026.05.09`, `.12`, `.13`, `.14`, `.16`, `.17` (the Livermore days), `v2026.09.08` (colsto's day) and `v2026.11.01`, each with a `staging-0` twin (no `prod-1`). 3.2 to 3.9 GB a day.

#### Unheard's history index (`pnpm history:build <day>`, format in `docs/history-format.md`)

`scripts/history-index.ts` streams a day's tar (never stored), unpacks each `trace_full_<hex>.json` in a worker, keeps the airborne points at or below 10,000 ft (pressure altitude; geometric when there is none) with a speed and a track, tags each aircraft with its kind from tar1090-db's ICAO type table (pinned commit), and writes 1° tiles (`evals/.cache/history/<day>/`, never committed). Measured on seven days on a shared machine (8 workers, the machine shared with other agents, so the times vary twice over):

| day | tar streamed | worker CPU | writing | peak memory | points kept (aircraft) | tiles | tile median / p99 / busiest | world MB (no jets) | contiguous US MB | Europe MB |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-05-09 (Sat) | 3.18 GB, 18 s | 86 s | 106 s | 3.8 GB | 42.9 M (55,456) | 2,570 | 9 kB / 1.5 MB / 3.7 MB 33_-112 | 266 (140) | 164 (104) | 67 (22) |
| 2026-05-12 (Tue) | 3.48 GB, 65 s | 218 s | 83 s | 2.2 GB | 49.6 M (60,073) | 2,770 | 8 kB / 1.8 MB / 4.1 MB 40_-74 | 309 (178) | 208 (138) | 57 (20) |
| 2026-05-13 (Wed) | 3.43 GB, 29 s | 122 s | 77 s | 2.6 GB | 47.1 M (58,927) | 2,752 | 8 kB / 1.7 MB / 4.4 MB 33_-112 | 293 (161) | 191 (122) | 56 (17) |
| 2026-05-14 (Thu) | 3.56 GB, 37 s | 132 s | 95 s | 2.4 GB | 48.8 M (60,589) | 2,681 | 8 kB / 1.8 MB / 4.5 MB 33_-112 | 304 (168) | 206 (133) | 52 (15) |
| 2026-05-16 (Sat) | 3.22 GB, 50 s | 198 s | 190 s | 2.2 GB | 42.9 M (55,437) | 2,551 | 9 kB / 1.6 MB / 4.7 MB 40_-75 | 267 (148) | 177 (117) | 52 (16) |
| 2026-05-17 (Sun) | 3.25 GB, 27 s | 122 s | 72 s | 2.8 GB | 41.1 M (53,464) | 2,603 | 7 kB / 1.4 MB / 4.6 MB 40_-75 | 254 (125) | 157 (93) | 60 (18) |
| 2026-09-08 (Tue) | 3.87 GB, 30 s | 135 s | 87 s | 2.6 GB | 55.9 M (70,953) | 3,042 | 8 kB / 1.7 MB / 4.1 MB 40_-74 | 345 (202) | 228 (155) | 62 (22) |

- About half the airborne points are kept (86 M parsed of 15 GB of JSON on 05-16, 42.9 M kept): 20,567 piston, 3,456 turboprop, 3,447 rotor, 24,466 jet and 3,501 other or unknown aircraft that day. A point costs about 6.2 bytes after gzip (16-bit columns of changes, low then high bytes).
- No tile passed 5 MB, so none was split: the busiest are Phoenix (33_-112), Philadelphia and New Jersey (40_-75) and New York (40_-74). The Bay Area's four tiles hold 6.7 MB a day.
- Average day: 291 MB for the world (160 MB without jets and unknown), 190 MB for the contiguous US, 58 MB for Europe. A month: 8.7 GB, 5.7 GB and 1.7 GB.
- Deterministic, checked: 2026-05-16 built twice (8 then 6 workers, separate folders, the type table fetched again) gave byte-identical manifests, so all 2,551 tiles have the same `sha256`.

### ADS-B Exchange free samples (first of each month)

- https://www.adsbexchange.com/data-products/sample-data/, files at https://samples.adsbexchange.com/:
  - `traces/YYYY/MM/DD/<last2>/trace_full_<hex>.json`: one aircraft, one day (2 to 8 s points at low altitude).
  - `hires-traces/YYYY/MM/DD/<last2>/trace_full_<hex>.json`: same format, **one point every 0.5 s** (tested: 109 to 120 points per 60 s clip). Best ground truth for Doppler.
  - `readsb-hist/YYYY/MM/DD/HHMMSSZ.json.gz`: global snapshot every 5 s since May 2020 (60 s since July 2016), about 6.5 MB each.
  - also `acas/`, `operations-ax-v2/`, `flights-ax-v2/`.
- Only the 1st of each month is free. Per-hex files are 0.1 to 1.3 MB. Tested present on 2023-03-01 and 2026-10-01.
- License: no explicit license on the samples; offered "for testing and evaluation". Commercial use needs a written agreement, no redistribution without consent. Keep these files out of the repo.
- **Fit: yes**, it is the only free history that covers Adelaide on an AeroSonicDB day (2023-03-01).

### OpenSky Network

- Terms (https://opensky-network.org/about/terms-of-use): data licensed **solely for non-profit research and non-profit education**; any use by a for-profit entity needs a written license; any operational REST use (even internal automation) needs a written agreement.
- REST: `/states/all?time=` reaches back **1 hour** only (registered, 5 s resolution); `/tracks` is experimental, 30 days back, sparse waypoints (every 15 min, or on 2.5 degree / 100 m change): useless for Doppler.
- Full history (Trino, `pyopensky`): requires an approved research account (academic or government affiliation).
- **Fit: no** for us unless we qualify as non-profit research; it would be the only way to get December 2022 and April-May 2023 Adelaide tracks for the rest of AeroSonicDB.

## Recommendation

First real dataset: **AeroSonicDB v1.1.2, the 9 clips of 2023-03-01 at location 1, paired with ADS-B Exchange `hires-traces` of that day.** Every clip has a trace at 0.5 s; 3 turboprop/piston, 2 helicopter (Bell 412), 4 jets. Measured from the hires traces (mic at -34.96092, 138.51311):

| clip | type | start UTC | audible (s) | closest approach | min horiz. dist | alt baro / geom | speed |
|---|---|---|---|---|---|---|---|
| 7C77D9_2023-03-01_13-29-31_1_1 | BE20 King Air, 4-blade | 02:59:31 | 12-37 | +24.5 s | 16 m | 775 / 925 ft | 145 kt |
| 7C5B4D_2023-03-01_13-37-12_1_1 | DH8C Dash 8 | 03:07:12 | 0-20 | +10.4 s | 12 m | 550 / 650 ft | 134 kt |
| 7C07CD_2023-03-01_13-39-41_1_1 | C172 | 03:09:41 | 15-48 | +26.6 s | 975 m | 500 / 550 ft | 112 kt |
| 7C7773_2023-03-01_13-51-22_1_1 | E190 | 03:21:22 | 8-36 | +18.5 s | 30 m | 925 / 1050 ft | 144 kt |
| 7C3A50_2023-03-01_14-01-01_1_1 | B412 helicopter | 03:31:01 | 30-60 | +59.3 s | 775 m | 900 / 1050 ft | 44 kt |
| 7C3A50_2023-03-01_14-10-05_1_1 | B412 helicopter | 03:40:05 | 0-40 | +17.7 s | 1491 m | 900 / 1050 ft | 117 kt |
| 7C6D29_2023-03-01_14-12-20_1_1 | B738 | 03:42:20 | 0-30 | +9.4 s | 26 m | 700 / 800 ft | 159 kt |
| 7C6DBA_2023-03-01_14-13-40_1_1 | B738 | 03:43:40 | 4-30 | +13.8 s | 37 m | 650 / 725 ft | 158 kt |
| 7C6DA0_2023-03-01_14-15-07_1_1 | B738 | 03:45:07 | 7-29 | +17.6 s | 32 m | 675 / 800 ft | 153 kt |

Sanity check on the King Air clip: the strongest 40-500 Hz peak falls 156, 143, 127, 117 Hz over seconds 20 to 26, around the ADS-B closest approach at 24.5 s. That matches a 4-blade prop at 2,000 rpm (133 Hz) Doppler-shifted at 145 kt. Location 1 is windy: expect strong energy below 60 Hz.

Steps for one sample (King Air, about 3 MB in total):

1. Metadata: `curl -L -o sample_meta.csv https://zenodo.org/api/records/10215080/files/sample_meta.csv/content` (same for `locations.json`, `aircraft_meta.csv`).
2. Audio, without the 1.17 GB zip (Zenodo serves HTTP ranges): `uvx remotezip -d audio https://zenodo.org/api/records/10215080/files/audio.zip/content audio/1/7C77D9_2023-03-01_13-29-31_1_1.wav` (`uvx remotezip -l <url>` lists all 1,895 members).
3. Time: `13-29-31` local ACDT on 2023-03-01 = **2023-03-01T02:59:31Z** (convert with the `Australia/Adelaide` zone, never a fixed offset).
4. Mic: location `1` in `locations.json` = -34.96092, 138.51311 (approximate).
5. ADS-B: `curl --compressed -o trace_full_7c77d9.json https://samples.adsbexchange.com/hires-traces/2023/03/01/d9/trace_full_7c77d9.json` (subfolder = last two hex digits, lowercase hex).
6. Keep the points with `timestamp + trace[i][0]` within the clip window (2023-03-01 02:59:31Z + 0 to 60 s): about 120 points with lat, lon, `alt_geom` (index 10), ground speed and track.
7. Expected answer: hex 7c77d9 (VH-XYJ, BE20), closest approach at 03:00:00Z, 16 m horizontally from the stated mic position.

Next steps, in order: turn the 9 pairs into an eval fixture (audio stays out of git: NC license; traces stay out of git: ADS-B Exchange terms); request AeroSonicDB 3K access (more props and helicopters, 16 kHz) and ask its author whether the 3K filenames still give the trigger time; record our own clips with the repo's `record-sky` poller running alongside, adsb.lol history as the backstop.

Open question for the maintainer: is unheard a commercial product? AeroSonicDB (NC), ADS-B Exchange samples and OpenSky all restrict commercial use; only adsb.lol (ODbL) is clear for it.
