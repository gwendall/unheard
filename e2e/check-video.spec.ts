import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { readMetadata } from "../lib/client/metadata";

// The cleaned video end to end, in browsers that have real codecs: the file's sound read as a
// stream, its tones taken out, the same video under the cleaned sound downloaded, and that file
// read back by Node (packets, metadata) and by the page (no tone left, through the real decoder).
// The videos are the flyby under a test picture, made by ffmpeg (scripts/make-e2e-fixture.ts).

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const SHOTS = process.env.SHOTS;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-desktop.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/${name}-phone.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** The picture's packets: their bytes, kinds and times. */
async function packetsOf(path: string) {
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
  const out: { hash: string; type: string; t: number }[] = [];
  try {
    const track = (await input.getPrimaryVideoTrack())!;
    for await (const p of new EncodedPacketSink(track).packets()) out.push({ hash: createHash("sha256").update(p.data).digest("hex"), type: p.type, t: p.timestamp });
    return { packets: out, tracks: (await input.getTracks()).map((t) => t.type).sort(), rotation: track.rotation, tags: await input.getMetadataTags() };
  } finally {
    input.dispose();
  }
}

/** Where "Find where" and the link beside it sit on the page, at a wide screen and a phone's. */
async function placesOf(page: Page) {
  const out: unknown[] = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of ["where-find", "check-elsewhere", "check-tags-download"]) {
      // A file with no tag has no copy to offer: gone on one side only would still show as a difference.
      if (await page.getByTestId(id).count()) out.push(await placeOf(page, id));
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  return out;
}

const placeOf = (page: Page, id: string) =>
  page.getByTestId(id).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
  });

async function clean(page: Page, file: string) {
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(file);
  await expect(page.getByTestId("check-verdict")).toHaveText(/could place this file\.$/, { timeout: 170_000 });
  const places = await placesOf(page);
  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-verdict")).toHaveText(/^The tones? (is|are) gone\.$/, { timeout: 300_000 });
  // The download is the one thing to do now, and what was on the page has not moved.
  await expect(page.getByTestId("where").locator("button.bg-amber, a.bg-amber")).toHaveCount(1);
  await expect(page.getByTestId("check-download")).toHaveClass(/bg-amber/);
  expect(await placesOf(page)).toEqual(places);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("check-download").click()]);
  return download;
}

/** The page's own search, through the browser's decoder, on what came out. */
async function noToneLeft(page: Page, path: string) {
  await page.getByTestId("where-another").setInputFiles(path);
  await expect(page.getByTestId("check-verdict")).toHaveText("No aircraft tone found.", { timeout: 170_000 });
}

test.setTimeout(600_000);

for (const [name, ext, meta] of [
  ["an MP4", "mp4", true],
  ["a MOV", "mov", true],
  ["a WebM", "webm", false],
] as const) {
  test(`${name} comes back as ${name}: same picture, no tone, nothing that names a place`, async ({ page }, info) => {
    const file = fixture(`flyby.${ext}`);
    test.skip(!existsSync(file), "no ffmpeg to make the fixture");
    const before = await packetsOf(file);
    const download = await clean(page, file);
    expect(download.suggestedFilename()).toBe(`flyby-cleaned.${ext}`);
    await expect(page.getByTestId("check-seen")).toContainText("The picture itself can still give the place away");
    if (meta) {
      await expect(page.getByTestId("check-removed")).toContainText("48.773, 2.119");
      await expect(page.getByTestId("check-removed")).toContainText("iPhone 15 Pro");
      await expect(page.getByTestId("check-removed")).toContainText("2026");
    }
    await shoot(page, `check-video-${ext}`);
    const out = info.outputPath(download.suggestedFilename());
    await download.saveAs(out);

    const after = await packetsOf(out);
    expect(after.tracks).toEqual(["audio", "video"]);
    expect(after.rotation).toBe(before.rotation);
    expect(after.packets.map((p) => p.hash)).toEqual(before.packets.map((p) => p.hash));
    expect(after.packets.map((p) => p.type)).toEqual(before.packets.map((p) => p.type));
    after.packets.forEach((p, i) => expect(Math.abs(p.t - before.packets[i].t)).toBeLessThan(0.002));
    expect(after.tags.date).toBeUndefined();
    const bytes = readFileSync(out);
    const said = await readMetadata(new Blob([bytes]));
    expect(said.location).toBeUndefined();
    expect(said.createdAt).toBeUndefined();
    expect(said.device).toBeUndefined();
    await noToneLeft(page, out);
  });
}

/** Each track's kind and all its packets, as one hash. */
async function tracksOf(path: string) {
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
  try {
    const out: { type: string; packets: number; hash: string }[] = [];
    for (const track of await input.getTracks()) {
      if (!track.isVideoTrack() && !track.isAudioTrack()) continue;
      const hash = createHash("sha256");
      let packets = 0;
      for await (const p of new EncodedPacketSink(track).packets()) {
        hash.update(p.data);
        packets++;
      }
      out.push({ type: track.type, packets, hash: hash.digest("hex") });
    }
    return out;
  } finally {
    input.dispose();
  }
}

/** What ffprobe reads in the file: its tags, then each track's. */
function probeTags(path: string) {
  const { format, streams } = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path]).toString()) as { format: { tags?: Record<string, string> }; streams: { tags?: Record<string, string> }[] };
  return { file: Object.keys(format.tags ?? {}), tracks: streams.flatMap((s) => Object.keys(s.tags ?? {})) };
}

/** Clicks the copy without its tags, saves it, and says what it holds: the file's picture and first sound as they were, and nothing it said. */
async function copyWithoutTags(page: Page, file: string, out: string, name: string, kept: string[]) {
  const before = await tracksOf(file);
  // A copy that never comes fails here, saying what the panel shows, rather than using up the whole run.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }).catch(async () => {
      throw new Error(`${name}: no download after 60 s, the panel reads: ${await page.getByTestId("check-tags").innerText()}`);
    }),
    page.getByTestId("check-tags-download").click({ timeout: 60_000 }),
  ]);
  expect(download.suggestedFilename()).toBe(name);
  await download.saveAs(out);
  const first = kept.map((type) => before.find((t) => t.type === type));
  expect(await tracksOf(out)).toEqual(first);
  const said = await readMetadata(new Blob([readFileSync(out)]));
  expect(said.location).toBeUndefined();
  expect(said.createdAt).toBeUndefined();
  expect(said.device).toBeUndefined();
  const probed = probeTags(out);
  // Only what names the format and the software that wrote it.
  expect(probed.file.filter((key) => !["major_brand", "minor_version", "compatible_brands", "encoder"].includes(key))).toEqual([]);
  expect(probed.tracks.filter((key) => !["language", "handler_name", "encoder", "vendor_id"].includes(key))).toEqual([]);
  return readFileSync(out);
}

test("a copy without its tags: the same picture and sound, and nothing the file said", async ({ page }, info) => {
  const file = fixture("flyby.mp4");
  test.skip(!existsSync(file), "no ffmpeg to make the fixture");
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(file);
  // Offered at once, before any tone: the check goes on beside it.
  await expect(page.getByTestId("check-tags-note")).toContainText("The sound is unchanged");
  await expect(page.getByTestId("check-tags-note")).toContainText("the picture can still give the place away");
  await shoot(page, "check-tags-video");
  const out = info.outputPath("flyby-no-tags.mp4");
  const bytes = await copyWithoutTags(page, file, out, "flyby-no-tags.mp4", ["video", "audio"]);
  for (const said of ["iPhone", "+48.77", "2026-05-16", "com.apple.quicktime"]) expect(bytes.includes(said), said).toBe(false);
  // It says nothing, so nothing is offered for it.
  await page.getByTestId("where-another").setInputFiles(out);
  await expect(page.getByTestId("check-verdict")).toBeVisible({ timeout: 170_000 });
  await expect(page.getByTestId("check-tags")).toHaveCount(0);
});

for (const ext of ["mov", "webm"]) {
  test(`a ${ext} without its tags comes back as a ${ext}`, async ({ page }, info) => {
    const file = fixture(`flyby.${ext}`);
    test.skip(!existsSync(file), "no ffmpeg to make the fixture");
    await page.goto("/where");
    await page.getByTestId("where-file").setInputFiles(file);
    await expect(page.getByTestId("check-tags-note")).toContainText("The sound is unchanged");
    await copyWithoutTags(page, file, info.outputPath(`flyby-no-tags.${ext}`), `flyby-no-tags.${ext}`, ["video", "audio"]);
  });
}

test("a file with no tone still gets its copy without tags", async ({ page }, info) => {
  const file = fixture("quiet.mp4");
  test.skip(!existsSync(file), "no ffmpeg to make the fixture");
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(file);
  // The verdict lands while the button is there to be clicked: it must not move it from under the click.
  await expect(page.getByTestId("check-tags-download")).toBeVisible({ timeout: 60_000 });
  const place = await placeOf(page, "check-tags-download");
  await expect(page.getByTestId("check-verdict")).toHaveText("No aircraft tone found.", { timeout: 170_000 });
  expect(await placeOf(page, "check-tags-download")).toEqual(place);
  await shoot(page, "check-tags-no-tone");
  await copyWithoutTags(page, file, info.outputPath("quiet-no-tags.mp4"), "quiet-no-tags.mp4", ["video", "audio"]);
});

test("a video with no sound still gets its copy without tags", async ({ page }, info) => {
  const file = fixture("silent.mp4");
  test.skip(!existsSync(file), "no ffmpeg to make the fixture");
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(file);
  await expect(page.getByTestId("check-trouble")).toContainText("This video has no sound track", { timeout: 60_000 });
  await expect(page.getByTestId("check-tags-note")).toContainText("the same picture");
  await expect(page.getByTestId("check-tags-note")).not.toContainText("sound");
  await shoot(page, "check-tags-silent");
  await copyWithoutTags(page, file, info.outputPath("silent-no-tags.mp4"), "silent-no-tags.mp4", ["video"]);
});

test("sound files get theirs too, each in its own kind", async ({ page }, info) => {
  for (const ext of ["mp3", "m4a", "flac", "ogg", "wav"]) {
    const file = fixture(`tagged.${ext}`);
    test.skip(!existsSync(file), "no ffmpeg to make the fixture");
    await page.goto("/where");
    await page.getByTestId("where-file").setInputFiles(file);
    await expect(page.getByTestId("check-tags-note")).toContainText("The sound is unchanged");
    await expect(page.getByTestId("check-tags-note")).not.toContainText("picture");
    const bytes = await copyWithoutTags(page, file, info.outputPath(`tagged-no-tags.${ext}`), `tagged-no-tags.${ext}`, ["audio"]);
    for (const said of ["Marked title", "Marked artist", "2026-05-16"]) expect(bytes.includes(said), `${ext}: ${said}`).toBe(false);
  }
});

test("tags on a file we cannot write: one line saying so, and no button", async ({ page }) => {
  const file = fixture("old-picture.mp4");
  test.skip(!existsSync(file), "no ffmpeg to make the fixture");
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(file);
  await expect(page.getByTestId("check-tags-why")).toContainText("We cannot write this kind of file");
  await expect(page.getByTestId("check-tags-why")).toContainText("it keeps any date, place or device");
  await expect(page.getByTestId("check-tags-download")).toHaveCount(0);
});

test("a container it cannot write: the cleaned sound, and one line saying why", async ({ page }) => {
  const file = fixture("flyby.ts");
  test.skip(!existsSync(file), "no ffmpeg to make the fixture");
  const download = await clean(page, file);
  expect(download.suggestedFilename()).toBe("flyby-cleaned.wav");
  // No tag in this one, so no copy is offered for it.
  await expect(page.getByTestId("check-tags")).toHaveCount(0);
  await expect(page.getByTestId("check-why")).toContainText("We cannot write this kind of video");
  await expect(page.getByTestId("check-why")).toContainText("still holds");
  await shoot(page, "check-video-fallback");
});

test("no encoder for this sound: the cleaned sound, and one line saying why", async ({ page, browserName }) => {
  test.skip(browserName !== "firefox", "only Firefox has no AAC encoder of its own");
  const file = fixture("flyby.mp4");
  test.skip(!existsSync(file), "no ffmpeg to make the fixture");
  // The stand-in encoder never arrives, as where a network or a policy stops it. Told by what the
  // script holds: a build may name it anything, and a small loader bearing its name comes first.
  await page.route(/\/_next\/static\/.*\.js/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.length > 500_000 && body.includes("registerAacEncoder")) await route.abort();
    else await route.fulfill({ response, body });
  });
  const download = await clean(page, file);
  expect(download.suggestedFilename()).toBe("flyby-cleaned.wav");
  await expect(page.getByTestId("check-why")).toContainText("This browser cannot encode the sound of a video");
});

test("a video with no sound says so", async ({ page }) => {
  const file = fixture("silent.mp4");
  test.skip(!existsSync(file), "no ffmpeg to make the fixture");
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(file);
  await expect(page.getByTestId("check-trouble")).toContainText("This video has no sound track", { timeout: 60_000 });
  await expect(page.getByTestId("check-trouble")).toContainText("its picture can still give it away");
  await expect(page.getByTestId("check-clean")).toHaveCount(0);
  await shoot(page, "check-video-silent");
});

test("the French page, for the screenshots", async ({ page }) => {
  test.skip(!SHOTS, "screenshots only");
  await page.goto("/fr/where");
  await page.getByTestId("where-file").setInputFiles(fixture("flyby.mp4"));
  await expect(page.getByTestId("check-verdict")).toContainText("qui pourrai", { timeout: 170_000 });
  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-download")).toBeVisible({ timeout: 300_000 });
  await shoot(page, "check-video-fr");
  await page.goto("/fr/where");
  await page.getByTestId("where-file").setInputFiles(fixture("silent.mp4"));
  await expect(page.getByTestId("check-trouble")).toContainText("Cette vidéo n'a pas de piste son", { timeout: 60_000 });
  await shoot(page, "check-video-fr-silent");
  await page.goto("/fr/where");
  await page.getByTestId("where-file").setInputFiles(fixture("flyby.ts"));
  await expect(page.getByTestId("check-verdict")).toContainText("qui pourrai", { timeout: 170_000 });
  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-download")).toBeVisible({ timeout: 300_000 });
  await shoot(page, "check-video-fr-fallback");
});
