import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { encodeWav } from "../lib/bundle";
import { STANDARD_AIR } from "../lib/core/doppler";
import { synthesize } from "../lib/core/synth";
import { scene, sceneWav } from "./where-scene";

// The where page end to end in a real Chromium: a made-up recording of real flights (e2e/history,
// adsb.lol, ODbL) decoded by Web Audio, searched in the worker over tiles from the dev route, and
// the answer. The sound is never in a request.

const SHOTS = process.env.SHOTS;
const HOUR = new Date(scene.start * 1000).toISOString().slice(11, 16);

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-desktop.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/${name}-phone.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function fillIn(page: Page) {
  await page.getByTestId("where-day").selectOption(scene.day);
  await page.getByTestId("where-time").fill(HOUR);
  await page.getByTestId("where-zone").selectOption("utc");
  // Not the spot itself: a place some way off, the way a person knows roughly where.
  await page.getByTestId("where-place").fill(`${(scene.lat + 0.12).toFixed(2)}, ${(scene.lon - 0.09).toFixed(2)}`);
}

/** The file named in a QuickTime box holding a date and a position, as a phone writes them. */
function phoneVideo(start = scene.start): Buffer {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const box = (type: string, ...parts: (number[] | Buffer)[]) => {
    const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
    return Buffer.concat([Buffer.from(u32(8 + body.length)), Buffer.from(type, "latin1"), body]);
  };
  const at = Math.round(start) + 2_082_844_800;
  const place = Buffer.from("+33.4727-111.7187/", "latin1");
  return Buffer.concat([
    box("ftyp", Buffer.from("qt  ", "latin1"), u32(512), Buffer.from("qt  ", "latin1")),
    box("moov", box("mvhd", [0, 0, 0, 0], u32(at), u32(at), u32(600), u32(0), new Array<number>(80).fill(0)), box("udta", box("\xa9xyz", [(place.length >> 8) & 0xff, place.length & 0xff, 0x15, 0xc7], place))),
  ]);
}

test("a file in, where and when it was recorded out, and the file is never sent", async ({ page }, info) => {
  const wav = info.outputPath("flyovers.wav");
  writeFileSync(wav, await sceneWav());
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") sent.push(`${r.method()} ${r.url()}`);
  });

  await page.goto("/where");
  await expect(page.locator("h1")).toHaveText("Where was this recorded?");
  await expect(page.getByTestId("where-private")).toContainText("nothing of it is sent");
  await shoot(page, "where-idle");

  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("where-name")).toHaveText("flyovers.wav");
  await expect(page.getByTestId("where-search")).toBeDisabled();
  await expect(page.getByTestId("where-hour-why")).toHaveText("An hour or so gives better answers than a whole day.");
  await fillIn(page);
  await expect(page.getByTestId("where-place-hint")).toContainText("100 km square");
  await shoot(page, "where-form");

  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-progress")).toBeVisible();
  await expect(page.getByTestId("where-verdict")).toHaveText("Probably here", { timeout: 170_000 });

  const spot = (await page.getByTestId("where-spot").innerText()).split(", ").map(Number);
  expect(Math.hypot((spot[0] - scene.lat) * 111_195, (spot[1] - scene.lon) * 111_195 * Math.cos((scene.lat * Math.PI) / 180))).toBeLessThan(300);
  await expect(page.getByTestId("where-start")).toContainText(`${scene.day} at ${HOUR}`);
  await expect(page.getByTestId("where-osm")).toHaveAttribute("href", /openstreetmap\.org.*mlat=33\.47/);
  const planes = page.getByTestId("where-planes").locator("li");
  await expect(planes.first()).toContainText(/ away, passed at \d\d:\d\d:\d\d UTC/);
  await expect(page.getByTestId("where-explains")).toContainText(/^Explains \d+ flyovers?: /);
  await expect(page.getByTestId("where-explains")).toContainText(scene.aircraft[1].registration);
  await expect(page.getByTestId("where-result")).not.toContainText("8 of 20");
  await expect(page.getByTestId("where-planes")).toContainText(scene.aircraft[1].registration);
  await expect(page.getByTestId("where-result")).toContainText("© adsb.lol contributors");
  await expect(page.getByTestId("where-check")).toHaveAttribute("href", "/check");
  await shoot(page, "where-found");
  expect(sent).toEqual([]);

  await page.getByTestId("where-again").click();
  await expect(page.getByTestId("where-search")).toBeEnabled();
});

test("with too little to go on, leads with the best guess and the next answer, and says how often it is right", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText("Best guess", { timeout: 170_000 });
  await expect(page.getByTestId("where-said")).toContainText("about 8 of 20 of our test recordings when the hour is known");
  await expect(page.getByTestId("where-start")).toContainText("Would have started");
  await expect(page.getByTestId("where-result")).toContainText("The planes that would explain the tones");
  await expect(page.getByTestId("where-plot")).toContainText("Guess");
  const guesses = page.getByTestId("where-guesses").getByRole("button");
  await expect(guesses.first()).toHaveAttribute("aria-pressed", "true");
  await expect(guesses.first()).toContainText("Best guess: ");
  await expect(guesses.nth(1)).toContainText(/^Next answer: .+, [\d.,]+ k?m off$/);
  await shoot(page, "where-best-guess");
  const first = await page.getByTestId("where-spot").innerText();
  await guesses.nth(1).click();
  // The lead stays on the best guess; what is shown below it is the answer picked.
  await expect(page.getByTestId("where-spot")).toHaveText(first);
  await expect(page.getByTestId("where-shown-spot")).not.toHaveText(first);
  await expect(page.getByTestId("where-shown-start")).toContainText("Would have started");
  await shoot(page, "where-guesses");
});

test("says so when the file holds no tone", async ({ page }, info) => {
  const noise = info.outputPath("street.wav");
  const samples = synthesize({ start: 0, duration: 30, sampleRate: 16_000, air: STANDARD_AIR, sources: [], noise: 1, rumble: 1, hum: [{ freq: 50, level: 0.4 }], seed: 3 });
  writeFileSync(noise, encodeWav(samples, 16_000));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(noise);
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText("No aircraft tone found.", { timeout: 60_000 });
  await shoot(page, "where-none");
});

test("a file that says where it was filmed says so first, and fills in what it knows", async ({ page }, info) => {
  const video = info.outputPath("phone.mov");
  writeFileSync(video, phoneVideo());
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(video);
  await expect(page.getByTestId("where-gps")).toContainText("This file already says where it was filmed: 33.4727, -111.7187");
  await expect(page.getByTestId("where-day")).toHaveValue(scene.day);
  await expect(page.getByTestId("where-time")).toHaveValue(HOUR);
  await expect(page.getByTestId("where-zone")).toHaveValue("utc");
  await expect(page.getByTestId("where-from-file")).toContainText("mvhd");
  await expect(page.getByTestId("where-days")).toHaveText(`The flight archive is still filling and holds ${scene.day} so far: each day's flights arrive the next day, older days a few at a time.`);
  await expect(page.getByTestId("where-search")).toBeEnabled();
  await shoot(page, "where-gps");
});

test("offers only the days the archive holds, and says so when the file's date is not one", async ({ page }, info) => {
  const video = info.outputPath("elsewhen.mov");
  writeFileSync(video, phoneVideo(Date.parse("2026-09-08T12:00:00Z") / 1000));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(video);
  const absent = page.getByTestId("where-day-absent");
  await expect(absent).toContainText("This file's date, 2026-09-08, is not in the flight archive yet.");
  await expect(absent).toContainText(`holds ${scene.day} so far: each day's flights arrive the next day`);
  // The prompt and the one day of the fixture.
  await expect(page.getByTestId("where-day").locator("option")).toHaveCount(2);
  await expect(page.getByTestId("where-search")).toBeDisabled();
  await shoot(page, "where-absent");
  await page.getByTestId("where-day").selectOption(scene.day);
  await expect(page.getByTestId("where-time")).toHaveValue("");
  await expect(page.getByTestId("where-search")).toBeEnabled();
});

test("does not promise a file older than the archive will reach", async ({ page }, info) => {
  const video = info.outputPath("old.mov");
  writeFileSync(video, phoneVideo(Date.parse("2023-06-01T12:00:00Z") / 1000));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(video);
  await expect(page.getByTestId("where-day-absent")).toHaveText(`This file's date, 2023-06-01, is before the flight archive starts, on 2026-01-01. It holds ${scene.day} so far.`);
  await shoot(page, "where-too-old");
});

test("the home and the check link here only when the archive is set", async ({ page }) => {
  const links = process.env.ARCHIVE_SET ? 1 : 0;
  await page.goto("/");
  await expect(page.getByTestId("check-link")).toBeVisible();
  await expect(page.getByTestId("where-link")).toHaveCount(links);
  if (links) await expect(page.getByTestId("where-link")).toHaveAttribute("href", "/where");
  if (links) await shoot(page, "where-home-link");
  await page.goto("/check");
  await expect(page.getByTestId("check-drop")).toBeVisible();
  await expect(page.getByTestId("where-link")).toHaveCount(links);
  if (links) await expect(page.getByTestId("where-link")).toHaveAttribute("href", "/where");
  if (links) await shoot(page, "where-check-link");
});

test("without the archive it says so, offers no search, and still reads the file", async ({ page }, info) => {
  test.skip(!process.env.NO_ARCHIVE, "needs a server started with NEXT_PUBLIC_HISTORY_URL empty");
  const video = info.outputPath("phone.mov");
  writeFileSync(video, phoneVideo());
  await page.goto("/where");
  await expect(page.getByTestId("where-offline")).toContainText("not connected yet");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await shoot(page, "where-offline");
  await page.getByTestId("where-file").setInputFiles(video);
  await expect(page.getByTestId("where-gps")).toContainText("33.4727, -111.7187");
  await expect(page.getByTestId("where-from-file")).toContainText(scene.day);
  await expect(page.getByTestId("where-search")).toHaveCount(0);
  await shoot(page, "where-offline-file");
  await page.goto("/fr/where");
  await expect(page.getByTestId("where-offline")).toContainText("pas encore branchée");
  await shoot(page, "where-fr-offline");
});

test("the French page, for the screenshots", async ({ page }, info) => {
  test.skip(!SHOTS || !!process.env.NO_ARCHIVE, "screenshots only");
  const wav = info.outputPath("flyovers.wav");
  writeFileSync(wav, await sceneWav());
  await page.goto("/fr/where");
  await expect(page.locator("h1")).toHaveText(/Où a-t-on enregistré ça/);
  await shoot(page, "where-fr-idle");
  await page.getByTestId("where-file").setInputFiles(wav);
  await fillIn(page);
  await expect(page.getByTestId("where-days")).toContainText("les vols d'un jour arrivent le lendemain");
  await shoot(page, "where-fr-form");
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText("Probablement ici", { timeout: 170_000 });
  await shoot(page, "where-fr-found");
});

test("the French best guess, for the screenshots", async ({ page }, info) => {
  test.skip(!SHOTS || !!process.env.NO_ARCHIVE, "screenshots only");
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/fr/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText("Meilleure hypothèse", { timeout: 170_000 });
  await expect(page.getByTestId("where-said")).toContainText("environ 8 de nos 20");
  await shoot(page, "where-fr-best-guess");
});
