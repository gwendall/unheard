import { truncateSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { encodeWav } from "../lib/bundle";
import { STANDARD_AIR } from "../lib/core/doppler";
import { synthesize } from "../lib/core/synth";
import { scene, sceneWav } from "./where-scene";

// The one flow for a file end to end in a real Chromium: a made-up recording of real flights
// (e2e/history, adsb.lol, ODbL) decoded by Web Audio, what the file says, its tones, the search in
// the worker over tiles from the dev route, and the answer. The sound is never in a request.

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

/** A WAV with a date tag, the way an editor leaves it. */
function dated(wav: Uint8Array, when: string): Buffer {
  const chunk = (id: string, data: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length);
    return Buffer.concat([Buffer.from(id, "latin1"), size, data, Buffer.alloc(data.length % 2)]);
  };
  const out = Buffer.concat([wav, chunk("LIST", Buffer.concat([Buffer.from("INFO", "latin1"), chunk("ICRD", Buffer.from(`${when}\0`, "latin1"))]))]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/** Where the things that stay on screen are: as a result arrives, none of them may move. */
const rectsOf = (page: Page, ids: string[]) =>
  page.evaluate((list) => {
    const out: Record<string, number[]> = {};
    for (const id of list) {
      const r = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
      out[id] = [r.x, r.y, r.width, r.height].map(Math.round);
    }
    return out;
  }, ids);

const STAY = ["where-name", "where-facts", "check-slot", "where-find"];

/** The tones found, then the search's form. */
async function openForm(page: Page) {
  await page.getByTestId("where-find").click({ timeout: 90_000 });
}

test("a file in: what it says at once, its tones, then where and when, and the file is never sent", async ({ page }, info) => {
  const wav = info.outputPath("flyovers.wav");
  writeFileSync(wav, await sceneWav());
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.method() !== "HEAD") sent.push(`${r.method()} ${r.url()}`);
  });
  await page.goto("/where");
  await expect(page.locator("h1")).toHaveText("Where was this filmed?");
  await expect(page.getByTestId("where-private")).toContainText("nothing of it is sent");
  await expect(page.locator("main")).toContainText("can sometimes tell");
  await shoot(page, "where-idle");
  const heading = await page.locator("h1").boundingBox();

  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("where-name")).toHaveText("flyovers.wav");
  await expect(page.getByTestId("where-facts-none")).toContainText("says nothing about where or when");
  await expect(page.getByTestId("where-find")).toBeDisabled();
  await expect(page.getByTestId("check-progress")).toBeVisible();
  expect(await page.locator("h1").boundingBox()).toEqual(heading);
  const before = await rectsOf(page, STAY);
  await shoot(page, "where-opening");

  await expect(page.getByTestId("check-verdict")).toHaveText(/^(An aircraft tone|\d+ aircraft tones) that could place this file\.$/, { timeout: 90_000 });
  await expect(page.getByTestId("check-tones").locator("li").first()).toContainText(/\d:\d\d to \d:\d\d in the file/);
  expect(await rectsOf(page, STAY)).toEqual(before);
  await expect(page.getByTestId("check-elsewhere")).toHaveAttribute("href", "/somewhere-else");
  await shoot(page, "where-tones");

  await openForm(page);
  await expect(page.getByTestId("where-place")).toBeFocused();
  await expect(page.getByTestId("where-search")).toBeDisabled();
  await expect(page.getByTestId("where-hour-why")).toHaveText("An hour or so gives better answers than a whole day.");
  await fillIn(page);
  await expect(page.getByTestId("where-place-hint")).toContainText("100 km square");
  await shoot(page, "where-form");

  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-progress")).toBeVisible();
  await expect(page.getByTestId("where-estimate")).toBeVisible();
  await expect(page.getByTestId("where-cancel")).toBeVisible();
  // The rest of the page stays usable meanwhile.
  await expect(page.getByTestId("check-clean")).toBeEnabled();
  await shoot(page, "where-searching");
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
  await shoot(page, "where-found");

  // On a wide screen the plot stays beside the planes as they scroll: no hole under it.
  await page.getByTestId("where-planes").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 40));
  const plot = await page.getByTestId("where-plot").boundingBox();
  expect(plot!.y).toBeGreaterThanOrEqual(0);
  expect(plot!.y).toBeLessThan(120);

  expect(sent).toEqual([]);
});

test("a search can be cancelled, and the form comes back as it was", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  await fillIn(page);
  const place = await page.getByTestId("where-place").inputValue();
  await page.getByTestId("where-search").click();
  await page.getByTestId("where-cancel").click();
  await expect(page.getByTestId("where-progress")).toHaveCount(0);
  await expect(page.getByTestId("where-search")).toBeEnabled();
  await expect(page.getByTestId("where-place")).toHaveValue(place);
  await expect(page.getByTestId("where-result")).toHaveCount(0);
});

test("with too little to go on, leads with the best guess and the next answer, and says how often it is right", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText("Best guess", { timeout: 170_000 });
  await expect(page.getByTestId("where-said")).toContainText("about 8 of 20 of our test recordings when the hour is known");
  // The form gave way under the visitor's eyes: they are taken to the answer's first line.
  await expect(page.getByTestId("where-verdict")).toBeFocused();
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

test("says so when the file holds no tone, offers no search, and never says the file is safe", async ({ page }, info) => {
  const noise = info.outputPath("street.wav");
  const samples = synthesize({ start: 0, duration: 30, sampleRate: 16_000, air: STANDARD_AIR, sources: [], noise: 1, rumble: 1, hum: [{ freq: 50, level: 0.4 }], seed: 3 });
  writeFileSync(noise, encodeWav(samples, 16_000));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(noise);
  await expect(page.getByTestId("check-verdict")).toHaveText("No aircraft tone found.", { timeout: 60_000 });
  await expect(page.getByTestId("check")).toContainText("That does not make the file safe");
  await expect(page.getByTestId("where-find")).toHaveCount(0);
  await shoot(page, "where-none");
});

test("a video with no sound track: its own tags said first and big, and the missing sound said plainly", async ({ page }, info) => {
  const video = info.outputPath("phone.mov");
  writeFileSync(video, phoneVideo());
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(video);
  await expect(page.getByTestId("where-gps")).toContainText("This file already says where it was filmed: 33.4727, -111.7187");
  await expect(page.getByTestId("where-made")).toHaveText(`${scene.day} ${HOUR} UTC`);
  await expect(page.getByTestId("check-trouble")).toContainText("no sound we can read", { timeout: 30_000 });
  await expect(page.getByTestId("where-find")).toHaveCount(0);
  await shoot(page, "where-gps");
});

test("a file too big for a browser is said at once, after what its tags say", async ({ page }, info) => {
  const big = info.outputPath("long.mp4");
  writeFileSync(big, Buffer.alloc(16));
  // Sparse: 2.5 GB on paper, nothing on the disk.
  truncateSync(big, 2.5 * 1024 ** 3);
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(big);
  await expect(page.getByTestId("check-trouble")).toContainText("too big for a browser");
  await expect(page.getByTestId("where-find")).toHaveCount(0);
  await shoot(page, "where-too-big");
});

test("fills in the day and hour from the file, and says where they came from", async ({ page }, info) => {
  const wav = info.outputPath("tagged.wav");
  writeFileSync(wav, dated(await sceneWav(90), `${scene.day}T${HOUR}:00`));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("where-made")).toContainText(`${scene.day} ${HOUR}`);
  await openForm(page);
  await expect(page.getByTestId("where-day")).toHaveValue(scene.day);
  await expect(page.getByTestId("where-time")).toHaveValue(HOUR);
  await expect(page.getByTestId("where-from-file")).toContainText("ICRD");
  await expect(page.getByTestId("where-days")).toHaveText(`The flight archive is still filling and holds ${scene.day} so far: each day's flights arrive the next day, older days a few at a time.`);
  await expect(page.getByTestId("where-place")).toBeFocused();
  await shoot(page, "where-prefilled");
});

test("offers only the days the archive holds, and says so when the file's date is not one", async ({ page }, info) => {
  const wav = info.outputPath("elsewhen.wav");
  writeFileSync(wav, dated(await sceneWav(90), "2026-09-08"));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  const absent = page.getByTestId("where-day-absent");
  await expect(absent).toContainText("This file's date, 2026-09-08, is not in the flight archive yet.");
  await expect(absent).toContainText(`holds ${scene.day} so far: each day's flights arrive the next day`);
  // The prompt and the one day of the fixture.
  await expect(page.getByTestId("where-day").locator("option")).toHaveCount(2);
  await expect(page.getByTestId("where-search")).toBeDisabled();
  await shoot(page, "where-absent");
  await page.getByTestId("where-day").selectOption(scene.day);
  await page.getByTestId("where-place").fill("33.5, -111.8");
  await expect(page.getByTestId("where-search")).toBeEnabled();
});

test("does not promise a file older than the archive will reach", async ({ page }, info) => {
  const wav = info.outputPath("old.wav");
  writeFileSync(wav, dated(await sceneWav(90), "2023-06-01"));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  await expect(page.getByTestId("where-day-absent")).toHaveText(`This file's date, 2023-06-01, is before the flight archive starts, on 2026-01-01. It holds ${scene.day} so far.`);
  await shoot(page, "where-too-old");
});

test("takes the visitor's own location for the place, and says so when it cannot", async ({ page, context }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 33.5, longitude: -111.8 });
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  await page.getByTestId("where-locate").click();
  await expect(page.getByTestId("where-place")).toHaveValue("33.5000, -111.8000");
  await expect(page.getByTestId("where-place-hint")).toContainText("100 km square");
  await context.clearPermissions();
  await page.getByTestId("where-locate").click();
  await expect(page.getByTestId("where-find-panel").getByRole("alert")).toContainText("could not get your location", { timeout: 20_000 });
});

test("the whole page takes a drop, and shows it without moving anything", async ({ page }) => {
  await page.goto("/where");
  const zone = await page.getByTestId("where-drop").boundingBox();
  const frame = page.getByTestId("where-page-drop");
  const drag = (type: string) =>
    page.evaluate((t) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(64)], "dropped.wav", { type: "audio/wav" }));
      window.dispatchEvent(new DragEvent(t, { dataTransfer: data, bubbles: true, cancelable: true }));
    }, type);
  await expect(frame).toHaveCSS("opacity", "0");
  await drag("dragenter");
  await expect(frame).toHaveCSS("opacity", "1");
  expect(await page.getByTestId("where-drop").boundingBox()).toEqual(zone);
  await drag("drop");
  await expect(page.getByTestId("where-name")).toHaveText("dropped.wav");
  await expect(frame).toHaveCSS("opacity", "0");
  await expect(page.getByTestId("check-trouble")).toBeVisible({ timeout: 30_000 });
});

test("reached by keyboard, with the focus visible, and still under reduced motion", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/where");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    if (await page.getByTestId("where-file").evaluate((el) => el === document.activeElement)) break;
  }
  await expect(page.getByTestId("where-file")).toBeFocused();
  await expect(page.getByTestId("where-drop")).toHaveCSS("outline-style", "solid");
  await page.getByTestId("where-file").setInputFiles(wav);
  // The pulse does not repeat.
  const dot = page.getByTestId("check-progress").locator("span").first();
  await expect(dot).toHaveCSS("animation-iteration-count", "1");
  await expect(page.getByTestId("where-find")).toBeEnabled({ timeout: 90_000 });
  await page.getByTestId("where-find").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("where-place")).toBeFocused();
  await expect(page.getByTestId("where-place")).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("where-locate")).toBeFocused();
  await expect(page.getByTestId("where-locate")).toHaveCSS("outline-style", "solid");
});

test("the Hz labels have a dark backing", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  const label = page.getByTestId("check-tones").locator("span", { hasText: " Hz" }).first();
  await expect(label).toBeVisible({ timeout: 90_000 });
  expect(await label.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
});

test("nothing moves at phone width as the tones arrive", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("check-progress")).toBeVisible();
  const before = await rectsOf(page, STAY);
  await expect(page.getByTestId("where-find")).toBeEnabled({ timeout: 90_000 });
  expect(await rectsOf(page, STAY)).toEqual(before);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test("the home is the file's door: a drop goes straight into the flow, and the heading does not move", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Where was this filmed?");
  await shoot(page, "home");
  // A computer sees the way to a phone only behind the second door.
  await expect(page.getByTestId("qr")).toHaveCount(0);
  await page.getByTestId("listen").click();
  await expect(page.getByTestId("qr")).toBeVisible();
  await expect(page.getByTestId("listen-here")).toBeVisible();
  await shoot(page, "home-second-door");
  // Measured last: that click may have scrolled the page a little, and a drop keeps the scroll.
  const heading = await page.locator("h1").boundingBox();
  const door = await page.getByTestId("door").boundingBox();
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page).toHaveURL(/\/where$/);
  await expect(page.getByTestId("where-name")).toHaveText("one-pass.wav");
  expect(await page.locator("h1").boundingBox()).toEqual(heading);
  const card = await page.getByTestId("where").boundingBox();
  expect([card!.x, card!.y, card!.width]).toEqual([door!.x, door!.y, door!.width]);
  await expect(page.getByTestId("where-find")).toBeEnabled({ timeout: 90_000 });
});

test("the home takes a drop anywhere", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(64)], "dropped.wav", { type: "audio/wav" }));
    for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(page).toHaveURL(/\/where$/);
  await expect(page.getByTestId("where-name")).toHaveText("dropped.wav");
});

test("on a phone the second door opens at once, with no way to a phone in the way", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: 33.5, longitude: -111.8 } });
  try {
    const page = await context.newPage();
    await page.goto(new URL("/", process.env.BASE_URL ?? "http://localhost:3000").href);
    await page.getByTestId("listen").click();
    await expect(page.getByTestId("qr")).toHaveCount(0);
    await expect(page.getByTestId("sky-title")).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
  }
});

test("the French home, for the screenshots", async ({ page }) => {
  test.skip(!SHOTS, "screenshots only");
  await page.goto("/fr");
  await expect(page.locator("h1")).toHaveText("Où a-t-on filmé ça ?");
  await shoot(page, "home-fr");
});

test("/check is now this page, in every language", async ({ page }) => {
  await page.goto("/check");
  expect(new URL(page.url()).pathname).toBe("/where");
  await page.goto("/fr/check");
  expect(new URL(page.url()).pathname).toBe("/fr/where");
});

test("without the archive it says so, offers no search, and still reads the file", async ({ page }, info) => {
  test.skip(!process.env.NO_ARCHIVE, "needs a server started with NEXT_PUBLIC_HISTORY_URL empty");
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("where-offline")).toContainText("not connected yet");
  await expect(page.getByTestId("check-verdict")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("check-clean")).toBeEnabled();
  await expect(page.getByTestId("where-find")).toHaveCount(0);
  await shoot(page, "where-offline");
});

test("the French page, for the screenshots", async ({ page }, info) => {
  test.skip(!SHOTS || !!process.env.NO_ARCHIVE, "screenshots only");
  const wav = info.outputPath("flyovers.wav");
  writeFileSync(wav, await sceneWav());
  await page.goto("/fr/where");
  await expect(page.locator("h1")).toHaveText("Où a-t-on filmé ça ?");
  await shoot(page, "where-fr-idle");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("where-find")).toBeEnabled({ timeout: 90_000 });
  await shoot(page, "where-fr-tones");
  await page.getByTestId("where-find").click();
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
  await page.getByTestId("where-find").click({ timeout: 90_000 });
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText("Meilleure hypothèse", { timeout: 170_000 });
  await expect(page.getByTestId("where-said")).toContainText("environ 8 de nos 20");
  await shoot(page, "where-fr-best-guess");
});
