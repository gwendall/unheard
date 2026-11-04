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

async function clean(page: Page, file: string) {
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(file);
  await expect(page.getByTestId("check-verdict")).toHaveText(/could place this file\.$/, { timeout: 170_000 });
  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-verdict")).toHaveText(/^The tones? (is|are) gone\.$/, { timeout: 300_000 });
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

test("a container it cannot write: the cleaned sound, and one line saying why", async ({ page }) => {
  const file = fixture("flyby.ts");
  test.skip(!existsSync(file), "no ffmpeg to make the fixture");
  const download = await clean(page, file);
  expect(download.suggestedFilename()).toBe("flyby-cleaned.wav");
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
