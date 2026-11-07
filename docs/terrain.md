# The ground's height

The search needs the height of the ground, because how high a plane flew above a listener depends on
what the listener stands on. It reads the open terrain tiles (terrarium encoding, zoom 10, pixels of about
120 m at 37°) from `terrain/terrarium-z10.pmtiles` in our bucket, next to the flight archive, by range
requests. So a search touches our own site and bucket and nobody else, which `e2e/where.spec.ts` asserts.

`lib/client/cached.ts` reads the file with `pmtiles` and keeps the tiles on the device, as before, and
`lib/terrain.ts` decodes them, unchanged. A missing tile or a failed read still means flat ground at 0 m.
The evals and the fixture scripts still read the source through `lib/terrain-source.ts`, with their own
cache; the page never does.

## The file

Every tile of zoom 10 of the source, byte for byte: 1,048,576 tiles, oceans included, 1,044,698 distinct
contents, **78.4 GB**. That is **1.57 USD a month** at Tigris's 0.02 USD per GB per month, reads at 0.0005
USD per thousand and no fee on the bytes that leave. A search touches about 30 tiles, about 1 MB for a
100 km square.

`scripts/pmtiles-write.ts` plans the file from the source's listing, which gives each tile's size and MD5,
so the header and the directories come first and the file is written straight through with no disk. The
directories are 2.6 MB, 1,024 entries to a leaf: a search reads the first 16 KB, a few leaves of about
2.5 KB, then its tiles.

## Uploading

The bucket's keys live only on Fly, so it is a one-shot Machine of the app `unheard-history`, with the
data jobs' own image. It removes itself. The flight job's image and schedule are untouched:

```
fly deploy --build-only --push --config scripts/history-job.fly.toml -a unheard-history \
  --dockerfile scripts/data-job.Dockerfile --ignorefile scripts/data-job.dockerignore --image-label data-job-N .
fly machine run registry.fly.io/unheard-history:data-job-N --name terrain-z10 --region iad \
  --vm-size performance-2x --vm-memory 8192 --restart no --rm --detach -a unheard-history \
  -e PUBLIC_BASE=https://unheard-history.t3.tigrisbucket.io \
  --entrypoint "node --max-old-space-size=4096 scripts/terrain-job.ts"
```

Each tile is checked against its MD5 as it is read, each part against its own MD5 as it is written, and
at the end a sample of tiles is read back through the public file, the way the page does, and compared with
the source. To run only that comparison, with no keys: `node scripts/terrain-job.ts --check <base>`. To
take up a copy that stopped, pass the upload id of its log as `-e TERRAIN_UPLOAD_ID=<id>`.

The copy of 04/11/2026 took 25 minutes at 53 MB/s on that Machine, about 0.05 USD, and read back 68 tiles
identical to the source. Ground computed from the file and from the source at 6 sites, 1,681 points each,
came out identical to the bit.

The source has not changed since 2017, so there is no refresh to schedule. The end-to-end tests have their
own flat ground, 843 bytes: `node scripts/make-terrain-fixture.ts`.

## Attribution

Terrain Tiles by Mapzen, on [AWS's open data](https://registry.opendata.aws/terrain-tiles/). The caption
under the map links [the list of sources](https://github.com/tilezen/joerd/blob/master/docs/attribution.md):

- ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National
  Science Foundation awards 1043681, 1559691, and 1542736;
- Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
- Austria terrain data © offene Daten Österreichs - Digitales Geländemodell (DGM) Österreich;
- Canada terrain data contains information licensed under the Open Government Licence - Canada;
- Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM
  layers;
- Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration;
- Mexico terrain data source: INEGI, Continental relief, 2016;
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New
  Zealand Government (All rights reserved);
- Norway terrain data © Kartverket;
- United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights
  reserved;
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S.
  Geological Survey.
