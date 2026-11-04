import { copyFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { encodeWav } from "../lib/bundle";
import { STANDARD_AIR } from "../lib/core/doppler";
import { synthesize } from "../lib/core/synth";
import { cardFilled, fillIn, phoneVideo, scene, sceneWav } from "./where-scene";

// The one flow for a file end to end in a real Chromium: a made-up recording of real flights
// (e2e/history, adsb.lol, ODbL) decoded by Web Audio, what the file says, its tones, the search in
// the worker over tiles from the dev route, and the answer. The sound is never in a request.

const SHOTS = process.env.SHOTS;
const BUCKET = "unheard-history.t3.tigrisbucket.io";
const HOUR = new Date(scene.start * 1000).toISOString().slice(11, 16);
/** The scene's first seconds, up to its first plane and short of its second. */
const ONE_PASS = 50;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-desktop.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/${name}-phone.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
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
      const r = document.querySelector(id === "title" ? '[data-testid="answer"] h2' : `[data-testid="${id}"]`)!.getBoundingClientRect();
      out[id] = [r.x, r.y, r.width, r.height].map(Math.round);
    }
    return out;
  }, ids);

/** The answer's frame: from listening to whatever the file comes to, these hold. */
const STAY = ["where-name", "answer-no-map", "title", "answer-why", "answer-actions"];

/** What is not the answer folds under Details. */
async function details(page: Page) {
  const fold = page.getByTestId("answer-details");
  if (!(await fold.evaluate((el) => (el as HTMLDetailsElement).open))) await fold.locator("summary").first().click();
}

/** The search's form. */
/**
 * The scene's answer takes the flag, whatever its length: three planes heard well make it worth too
 * much. To see the page without the flag, the real result is taken down a notch on its way back,
 * with a second answer beside it.
 */
const withoutTheFlag = (page: Page) =>
  page.addInitScript(() => {
    const Real = window.Worker;
    window.Worker = class extends Real {
      set onmessage(listen: (e: MessageEvent) => void) {
        super.onmessage = (e: MessageEvent) => {
          const data = e.data as { type?: string; result?: { kind: string; guesses: { lat: number }[] } };
          if (data?.type !== "result" || data.result?.kind !== "found") return listen(e);
          const [first] = data.result.guesses;
          const next = { ...first, lat: first.lat + 0.05 };
          listen(new MessageEvent("message", { data: { ...data, result: { ...data.result, confident: false, guesses: [first, next] } } }));
        };
      }
    };
  });

async function openForm(page: Page) {
  await page.getByTestId("where-find").click();
}

test("a file in: what it says at once, its tones, then where and when, and the file is never sent", async ({ page }, info) => {
  const wav = info.outputPath("flyovers.wav");
  writeFileSync(wav, await sceneWav());
  const sent: string[] = [];
  const hosts = new Set<string>();
  const terrain: number[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.method() !== "HEAD") sent.push(`${r.method()} ${r.url()}`);
    if (/^https?:/.test(r.url())) hosts.add(new URL(r.url()).host);
  });
  page.on("response", (r) => {
    if (r.url().includes(".pmtiles") && r.url().includes("/terrain/")) terrain.push(r.status());
  });
  await page.goto("/where");
  await expect(page.locator("h1")).toHaveText("Where was this filmed?");
  await expect(page.getByTestId("where-private")).toContainText("nothing of it is sent");
  await expect(page.locator("main")).toContainText("can sometimes tell");
  await shoot(page, "where-idle");
  const heading = await page.locator("h1").boundingBox();

  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("where-name")).toHaveText("flyovers.wav");
  await details(page);
  await expect(page.getByTestId("where-facts-none")).toContainText("No date or place in the tags we read. GoPros, drones and some other cameras keep GPS elsewhere, where we do not look.");
  await expect(page.getByTestId("where-find")).toBeEnabled();
  await expect(page.getByTestId("check-progress")).toBeVisible();
  expect(await page.locator("h1").boundingBox()).toEqual(heading);
  // With a file in, what the header said has done its work: the heading stays, and one line of privacy.
  await expect(page.getByTestId("where-lead")).toHaveCount(0);
  await expect(page.getByTestId("where-private")).toHaveText("Your file stays in this browser.");
  const before = await rectsOf(page, STAY);
  await shoot(page, "where-opening");

  await expect(page.getByTestId("check-verdict")).toHaveText(/^(An aircraft sound|\d+ aircraft sounds) that could place this file\.$/, { timeout: 90_000 });
  await expect(page.getByTestId("check-tones").locator("li").first()).toContainText(/\d:\d\d to \d:\d\d in the file/);
  expect(await rectsOf(page, STAY)).toEqual(before);
  await expect(page.getByTestId("check-elsewhere")).toHaveAttribute("href", "/somewhere-else");
  await shoot(page, "where-tones");

  await openForm(page);
  // No date in the file: the first gap is the day, once the archive has said which days it holds.
  await expect(page.getByTestId("where-day")).toBeFocused({ timeout: 30_000 });
  await expect(page.getByTestId("where-search")).toBeDisabled();
  await expect(page.getByTestId("where-hour-why")).toHaveText("An hour or so gives better answers than a whole day.");
  await fillIn(page);
  await expect(page.getByTestId("where-place-hint")).toContainText("100 km square");
  await shoot(page, "where-form");

  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-progress")).toBeVisible();
  await expect(page.getByTestId("where-estimate")).toBeVisible();
  await expect(page.getByTestId("where-cancel")).toBeVisible();
  await expect(page.getByTestId("where-bar")).toBeVisible();
  // The best guess as soon as there is one, hedged, while the search refines it.
  const sofar = await page.getByTestId("where-sofar").boundingBox();
  await expect(page.getByTestId("where-sofar")).toContainText(/^Best so far: .+ UTC\. The search may still drop it\.$/, { timeout: 170_000 });
  expect(await page.getByTestId("where-sofar").boundingBox()).toEqual(sofar);
  // The rest of the page stays usable meanwhile.
  await expect(page.getByTestId("check-clean")).toBeEnabled();
  await shoot(page, "where-searching");
  await expect(page.getByTestId("where-verdict")).toHaveText("Probably filmed near Mesa, Arizona", { timeout: 170_000 });
  // One sentence and one date, in the words of the place: no UTC, no flyovers, up front.
  await expect(page.getByTestId("answer-when")).toHaveText(/^May 16, 2026, around 11:44.AM$/);
  await expect(page.getByTestId("answer-reason")).toHaveText(/^\d+ planes were passing there at that moment, and we can hear them in the sound\.$/);
  await expect(page.getByTestId("answer-plane").first()).toContainText(/ away, at \d+:\d\d.[AP]M$/);
  await expect(page.getByTestId("answer-planes")).toContainText(scene.aircraft[1].registration);
  await expect(page.getByTestId("where-spot")).toHaveCount(0);
  await shoot(page, "where-found");

  // The rest is a tap away.
  await details(page);
  await expect(page.getByTestId("where-place-name")).toHaveText("Near Mesa, Arizona, United States");
  // Local time from the town's own zone, no more "about, from the longitude".
  await expect(page.getByTestId("where-start")).not.toContainText("longitude");
  const spot = (await page.getByTestId("where-spot").innerText()).split(", ").map(Number);
  expect(Math.hypot((spot[0] - scene.lat) * 111_195, (spot[1] - scene.lon) * 111_195 * Math.cos((scene.lat * Math.PI) / 180))).toBeLessThan(300);
  await expect(page.getByTestId("where-start")).toContainText(`${scene.day} at ${HOUR}`);
  await expect(page.getByTestId("where-osm")).toHaveAttribute("href", /openstreetmap\.org.*mlat=33\.47/);
  const planes = page.getByTestId("where-planes").locator("li");
  await expect(planes.first()).toContainText(/ away, passed at \d\d:\d\d:\d\d UTC/);
  await expect(page.getByTestId("where-explains")).toContainText(/^Explains \d+ flyovers?: /);
  await expect(page.getByTestId("where-explains")).toContainText(scene.aircraft[1].registration);
  await expect(page.getByTestId("where-result")).not.toContainText("A place is named only");
  await expect(page.getByTestId("where-planes")).toContainText(scene.aircraft[1].registration);
  await expect(page.getByTestId("where-result")).toContainText("© adsb.lol contributors");
  await expect(page.getByTestId("where-result")).toContainText("Nothing leaves this page until you choose");

  // The answer first, the file's own findings under it, and one primary on the screen.
  const top = async (id: string) => (await page.getByTestId(id).boundingBox())!.y;
  expect(await top("where-verdict")).toBeLessThan(await top("check-verdict"));
  expect(await top("check-verdict")).toBeLessThan(await top("where-facts"));
  await expect(page.getByTestId("where-find")).toHaveCount(0);
  await expect(page.getByTestId("where-again")).toBeVisible();
  await expect(page.getByTestId("where").locator("button.bg-amber, a.bg-amber")).toHaveCount(1);
  await expect(page.getByTestId("where-share").locator("button.bg-amber")).toHaveCount(1);

  expect(sent).toEqual([]);
  // The whole search, the worker's requests included: the site and our bucket, nobody else.
  expect([...hosts].filter((host) => host !== new URL(page.url()).host && host !== BUCKET)).toEqual([]);
  // The ground's height came from our own file, by ranges.
  expect(terrain.length).toBeGreaterThan(0);
  expect([...new Set(terrain)]).toEqual([206]);
});

test("a result's card is made only on the sharer's click, and nothing is sent", async ({ page }, info) => {
  const wav = info.outputPath("scene.wav");
  writeFileSync(wav, await sceneWav());
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.method() !== "HEAD") sent.push(`${r.method()} ${r.url()}`);
  });
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-share")).toBeVisible({ timeout: 170_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("where-share").getByRole("button").click()]);
  expect(download.suggestedFilename()).toBe("unheard.png");
  const png = await download.path();
  if (SHOTS) copyFileSync(png, `${SHOTS}/where-card.png`);
  expect(statSync(png).size).toBeGreaterThan(50_000);
  expect(sent).toEqual([]);
  // No map here (the local archive has none): the card has the diagram, and no map to credit.
  await expect(page.getByTestId("place-map")).toHaveAttribute("data-state", "failed");
  expect(await cardFilled(page, png)).toBeLessThan(0.3);
});

test("a search can be cancelled, and the form comes back as it was", async ({ page }, info) => {
  const wav = info.outputPath("scene.wav");
  writeFileSync(wav, await sceneWav());
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

test("without the flag, leads with the best guess and the next answer, and says how often it is right", async ({ page }, info) => {
  const wav = info.outputPath("scene.wav");
  writeFileSync(wav, await sceneWav());
  await withoutTheFlag(page);
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText(/^Probably filmed near /, { timeout: 170_000 });
  // The form gave way under the visitor's eyes: they are taken to the answer's first line.
  await expect(page.getByTestId("where-verdict")).toBeFocused();
  await details(page);
  await expect(page.getByTestId("where-said")).toContainText("A place is named only when at least three planes");
  await expect(page.getByTestId("where-start")).toContainText("Would have started");
  await expect(page.getByTestId("where-result")).toContainText("The planes that would explain the tones");
  await expect(page.getByTestId("place-map")).toBeVisible();
  const guesses = page.getByTestId("where-guesses").getByRole("button");
  await expect(guesses.first()).toHaveAttribute("aria-pressed", "true");
  await expect(guesses.first()).toContainText(/^Best guess: [A-Z][a-z ]+, Arizona$/);
  await expect(guesses.nth(1)).toContainText(/^Next answer: .+, [\d.,]+ k?m off$/);
  await shoot(page, "where-best-guess");
  const first = await page.getByTestId("where-spot").innerText();
  const { x, y, width } = (await page.getByTestId("place-map").boundingBox())!;
  await guesses.nth(1).click();
  // The lead stays on the best guess; what is shown below it is the answer picked.
  await expect(page.getByTestId("where-spot")).toHaveText(first);
  await expect(page.getByTestId("where-shown-spot")).not.toHaveText(first);
  await expect(page.getByTestId("where-shown-start")).toContainText("Would have started");
  // What changes with the answer sits under the map: the map holds.
  expect(await page.getByTestId("place-map").boundingBox()).toMatchObject({ x, y, width });
  await shoot(page, "where-guesses");
});

test("one pass of a plane: too few says so with no click, no place is named, nothing is asked for, and no flight is read", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(ONE_PASS));
  const tiles: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith(".bin.gz")) tiles.push(r.url());
  });
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("where-verdict")).toHaveText("Can't tell where this was filmed", { timeout: 90_000 });
  await expect(page.getByTestId("answer-reason")).toHaveText("We heard planes, but not enough to be sure of a place. It takes at least three, each clear.");
  // What it can still do stays, quieter.
  await expect(page.getByTestId("check-clean")).toBeEnabled();
  await expect(page.getByTestId("where-anyway")).toBeVisible();
  await expect(page.getByTestId("where-find")).toHaveCount(0);
  await expect(page.getByTestId("answer-no-map")).toBeVisible();
  await details(page);
  await expect(page.getByTestId("where-said")).toContainText("at least three planes");
  await expect(page.getByTestId("where-said")).toContainText("if they bring more clear flyovers");
  await expect(page.getByTestId("where-search")).toHaveCount(0);
  await expect(page.getByTestId("where-day")).toHaveCount(0);
  await expect(page.getByTestId("where-spot")).toHaveCount(0);
  await expect(page.getByTestId("place-map")).toHaveCount(0);
  await expect(page.getByTestId("where-share")).toHaveCount(0);
  expect(tiles).toEqual([]);
  await shoot(page, "where-one-pass");
});

test("too few passes, looked at anyway: no place leads, and the candidates wait behind a link that says they are probably wrong", async ({ page }, info) => {
  const wav = info.outputPath("two-passes.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("where-anyway")).toContainText("probably be wrong", { timeout: 90_000 });
  await page.getByTestId("where-anyway").click();
  await fillIn(page);
  await page.getByTestId("where-search").click();
  const candidates = page.getByTestId("where-candidates");
  await expect(candidates).toContainText("probably wrong", { timeout: 170_000 });
  await expect(page.getByTestId("where-verdict")).toHaveText("Can't tell where this was filmed");
  await details(page);
  await expect(page.getByTestId("where-said")).toContainText("if they bring more clear flyovers");
  await expect(page.getByTestId("where-spot")).toHaveCount(0);
  await expect(page.getByTestId("place-map")).toHaveCount(0);
  await expect(page.getByTestId("where-share")).toHaveCount(0);
  await shoot(page, "where-refused");
  await candidates.click();
  await expect(page.getByTestId("where-probably-wrong")).toContainText("Probably wrong");
  await expect(page.getByTestId("where-guesses").getByRole("button").first()).toContainText("Candidate 1:");
  await expect(page.getByTestId("place-map")).toBeVisible();
  await expect(page.getByTestId("where-share")).toHaveCount(0);
  await shoot(page, "where-candidates");
});

test("too few passes, a search started before the check has counted: it stops before any flight is read", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(ONE_PASS));
  // The check's worker stays silent, so the search goes first and counts for itself.
  await page.addInitScript(() => {
    const Real = window.Worker;
    const seen = window as unknown as { checks: number };
    seen.checks = 0;
    window.Worker = function (url: string | URL, options?: WorkerOptions) {
      if (String(url).includes("where")) return new Real(url, options);
      seen.checks++;
      return { postMessage() {}, terminate() {} };
    } as unknown as typeof Worker;
  });
  const checks = () => page.evaluate(() => (window as unknown as { checks: number }).checks);
  const tiles: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith(".bin.gz")) tiles.push(r.url());
  });
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText("Can't tell where this was filmed", { timeout: 170_000 });
  await expect(page.getByTestId("where-spot")).toHaveCount(0);
  expect(tiles).toEqual([]);
  // It names no place, but its tones are known: the check does not start over, and does not say they could place the file.
  await expect(page.getByTestId("check-verdict")).toHaveText(/^(An aircraft sound|Aircraft sounds) in this file\.$/);
  await expect(page.getByTestId("check-clean")).toBeEnabled();
  const started = await checks();
  await page.waitForTimeout(5000);
  expect(await checks()).toBe(started);
  await expect(page.getByTestId("check-progress")).toHaveCount(0);
});

test("says so when the file holds no tone, offers no search, and never says the file is safe", async ({ page }, info) => {
  const noise = info.outputPath("street.wav");
  const samples = synthesize({ start: 0, duration: 30, sampleRate: 16_000, air: STANDARD_AIR, sources: [], noise: 1, rumble: 1, hum: [{ freq: 50, level: 0.4 }], seed: 3 });
  writeFileSync(noise, encodeWav(samples, 16_000));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(noise);
  await expect(page.getByTestId("where-verdict")).toHaveText("Can't tell where this was filmed", { timeout: 60_000 });
  await expect(page.getByTestId("answer-reason")).toHaveText("We did not hear any plane in the sound, and the file does not say.");
  await expect(page.getByTestId("check-verdict")).toHaveText("No aircraft sound found.");
  await expect(page.getByTestId("check")).toContainText("That does not make the file safe");
  await expect(page.getByTestId("where-find")).toHaveCount(0);
  await shoot(page, "where-none");
});

test("a video with no sound track: its own tags said first and big, and the missing sound said plainly", async ({ page }, info) => {
  const video = info.outputPath("phone.mov");
  writeFileSync(video, phoneVideo());
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(video);
  await expect(page.getByTestId("answer-title")).toHaveText("Filmed near Mesa, Arizona");
  await expect(page.getByTestId("answer-when")).toHaveText(/^May 16, 2026, 11:44.AM/);
  await expect(page.getByTestId("answer-map-note")).toContainText("never your file");
  await expect(page.getByTestId("place-map")).toBeVisible();
  await expect(page.getByTestId("check-trouble")).toContainText("no sound we can read", { timeout: 30_000 });
  await expect(page.getByTestId("where-find")).toHaveCount(0);
  await details(page);
  await expect(page.getByTestId("where-gps")).toContainText("This file already says where it was filmed: 33.4727, -111.7187");
  await expect(page.getByTestId("where-made")).toHaveText(`${scene.day} ${HOUR} UTC`);
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
  writeFileSync(wav, dated(await sceneWav(), `${scene.day}T${HOUR}:00`));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await details(page);
  await expect(page.getByTestId("where-made")).toContainText(`${scene.day} ${HOUR}`);
  await openForm(page);
  await expect(page.getByTestId("where-day")).toHaveValue(scene.day);
  await expect(page.getByTestId("where-time")).toHaveValue(HOUR);
  await expect(page.getByTestId("where-from-file")).toContainText("ICRD");
  await expect(page.getByTestId("where-days")).toHaveText(`The flight archive holds ${scene.day}: each day's flights arrive the next day.`);
  await expect(page.getByTestId("where-place")).toBeFocused();
  await shoot(page, "where-prefilled");
});

test("offers only the days the archive holds, and says so when the file's date is not one", async ({ page }, info) => {
  const wav = info.outputPath("elsewhen.wav");
  writeFileSync(wav, dated(await sceneWav(), "2026-09-08"));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  const absent = page.getByTestId("where-day-absent");
  await expect(absent).toContainText("This file's date, 2026-09-08, is not in the flight archive.");
  await expect(absent).toContainText(`holds ${scene.day}: each day's flights arrive the next day`);
  // The prompt and the one day of the fixture.
  await expect(page.getByTestId("where-day").locator("option")).toHaveCount(2);
  await expect(page.getByTestId("where-search")).toBeDisabled();
  await shoot(page, "where-absent");
  await page.getByTestId("where-day").selectOption(scene.day);
  await page.getByTestId("where-place").fill("33.5, -111.8");
  await expect(page.getByTestId("where-search")).toBeEnabled();
});

test("offers towns as you type, from our own files alone, without moving the page", async ({ page }, info) => {
  const wav = info.outputPath("scene.wav");
  writeFileSync(wav, await sceneWav());
  const asked: string[] = [];
  page.on("request", (r) => asked.push(r.url()));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  await page.getByTestId("where-day").selectOption(scene.day);
  await page.getByTestId("where-time").fill("12:00");
  await page.getByTestId("where-zone").selectOption("local");
  // In the page, not the window: typing may scroll the field into view.
  const top = () => page.getByTestId("where-search").evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const search = await top();

  const field = page.getByTestId("where-place");
  await field.pressSequentially("mes");
  const list = page.getByTestId("where-matches");
  await expect(list).toContainText("Mesa, Arizona, United States");
  await expect(field).toHaveAttribute("aria-expanded", "true");
  expect(await top()).toBe(search);
  await shoot(page, "where-matches");
  await field.press("Escape");
  await expect(list).toHaveCount(0);

  // The keyboard picks; the town's zone sets the hour: noon in Paris in May is 10:00 UTC, where the
  // longitude alone would say 12:00.
  await field.fill("paris");
  await expect(list).toContainText("Paris, Île-de-France, France");
  await field.press("ArrowDown");
  await field.press("ArrowUp");
  await field.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(field).toHaveValue("Paris, Île-de-France, France");
  await expect(page.getByTestId("where-place-hint")).toContainText("Paris, Île-de-France, France: we search a 100 km square");
  await expect(page.getByTestId("where-window")).toHaveText(`Start between ${scene.day} 09:30 and ${scene.day} 10:30 UTC`);

  // Coordinates have no zone until the search asks: no window it could not stand by.
  await field.fill("48.85, 2.35");
  await expect(page.getByTestId("where-search")).toBeEnabled();
  await expect(page.getByTestId("where-window")).toHaveCount(0);

  await field.fill("zzzz");
  await expect(page.getByTestId("where-no-place")).toContainText("No place by that name");
  await expect(page.getByTestId("where-search")).toBeDisabled();

  expect(asked.some((u) => u.includes("/places/v1/s/"))).toBe(true);
  expect(asked.filter((u) => !u.startsWith(new URL(page.url()).origin))).toEqual([]);
  // The first letters at most: never the name as typed.
  expect(asked.filter((u) => u.includes("paris") || u.includes("zzzz"))).toEqual([]);
});

test("does not promise a file older than the archive will reach", async ({ page }, info) => {
  const wav = info.outputPath("old.wav");
  writeFileSync(wav, dated(await sceneWav(), "2023-06-01"));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await openForm(page);
  await expect(page.getByTestId("where-day-absent")).toHaveText(`This file's date, 2023-06-01, is before the flight archive starts, on 2026-01-01. It holds ${scene.day} so far.`);
  await shoot(page, "where-too-old");
});

test("takes the visitor's own location for the place, and says so when it cannot", async ({ page, context }, info) => {
  const wav = info.outputPath("scene.wav");
  writeFileSync(wav, await sceneWav());
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
  const wav = info.outputPath("scene.wav");
  writeFileSync(wav, await sceneWav());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/where");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    if (await page.getByTestId("where-file").evaluate((el) => el === document.activeElement)) break;
  }
  await expect(page.getByTestId("where-file")).toBeFocused();
  await expect(page.getByTestId("where-drop")).toHaveCSS("outline-style", "solid");
  await page.getByTestId("where-file").setInputFiles(wav);
  await page.getByTestId("where-find").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("where-day")).toBeFocused();
  await expect(page.getByTestId("where-day")).toHaveCSS("outline-style", "solid");
  await page.getByTestId("where-place").focus();
  await expect(page.getByTestId("where-place")).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("where-locate")).toBeFocused();
  await expect(page.getByTestId("where-locate")).toHaveCSS("outline-style", "solid");
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("no field takes the focus: the keyboard stays shut and the page stays put", async ({ page }, info) => {
    const wav = info.outputPath("one-pass.wav");
    writeFileSync(wav, await sceneWav());
    await page.goto("/where");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await page.getByTestId("where-file").setInputFiles(wav);
    await openForm(page);
    await expect(page.getByTestId("where-day")).toBeEnabled();
    await expect(page.getByTestId("where-day")).not.toBeFocused();
    await expect(page.getByTestId("where-place")).not.toBeFocused();
  });
});

test("nothing jumps from the home to the tones, and what we check comes back under them", async ({ page }, info) => {
  const wav = info.outputPath("two-passes.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.addInitScript(() => {
    const seen: number[] = [];
    (window as unknown as { shifts: number[] }).shifts = seen;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) seen.push(e.value);
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  // The second door's card holds no hole: words at the top, what to do at the foot, little between.
  const words = (await page.getByTestId("second-door").locator("p").first().boundingBox())!;
  const button = (await page.getByTestId("listen").boundingBox())!;
  expect(button.y - (words.y + words.height)).toBeLessThan(64);
  await page.evaluate(() => (window as unknown as { shifts: number[] }).shifts.splice(0));
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page).toHaveURL(/\/where$/);
  await expect(page.getByTestId("check-progress")).toBeVisible();
  await expect(page.getByTestId("where-scope")).toHaveCount(0);
  await expect(page.getByTestId("where-verdict")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("where-scope")).toBeVisible();
  const shifts = await page.evaluate(() => (window as unknown as { shifts: number[] }).shifts);
  expect(shifts).toEqual([]);
});

test("the tones appear under Details as they are found, before the verdict, and the answer's frame holds", async ({ page }, info) => {
  // Longer than one chunk: a shorter file reports its tones only at its end, right before the verdict.
  const wav = info.outputPath("flyovers.wav");
  writeFileSync(wav, await sceneWav());
  await page.addInitScript(() => {
    const seen = { both: false, bar: 0 };
    (window as unknown as { seen: typeof seen }).seen = seen;
    setInterval(() => {
      if (document.querySelector('[data-testid="check-tones"] li') && document.querySelector('[data-testid="check-progress"]')) seen.both = true;
      seen.bar = Math.max(seen.bar, Number(document.querySelector('[data-testid="check-bar"]')?.getAttribute("aria-valuenow") ?? 0));
    }, 50);
  });
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("check-progress")).toBeVisible();
  // No number, no step, no time left: one thing happening.
  await expect(page.getByTestId("check-progress")).toHaveText("Listening for planes in the sound");
  await expect(page.locator('[data-testid="answer"] h2')).toHaveText("Listening for planes in the sound");
  const before = await rectsOf(page, STAY);
  await details(page);
  await expect(page.getByTestId("check-verdict")).toBeVisible({ timeout: 90_000 });
  expect(await rectsOf(page, STAY)).toEqual(before);
  const seen = await page.evaluate(() => (window as unknown as { seen: { both: boolean; bar: number } }).seen);
  expect(seen.both).toBe(true);
  expect(seen.bar).toBeGreaterThan(0);
});

/** Twenty minutes of plain noise at 8 kHz, as a WAV: long enough for a check that takes a while, with no tone at the end of it. */
function longNoise(seconds = 20 * 60): Uint8Array {
  const samples = new Float32Array(seconds * 8000);
  for (let i = 0, x = 12345; i < samples.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    samples[i] = (x / 2 ** 32 - 0.5) * 0.2;
  }
  return encodeWav(samples, 8000);
}

test("on a long file, Find where waits for nothing, a search runs ahead of the check, and the check says its piece after", async ({ page }, info) => {
  const wav = info.outputPath("long.wav");
  writeFileSync(wav, longNoise());
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  // Enabled while the check is still running, from the first moment.
  await expect(page.getByTestId("where-name")).toHaveText("long.wav");
  await expect(page.getByTestId("where-find")).toBeEnabled();
  await expect(page.getByTestId("check-progress")).toBeVisible();
  await expect(page.getByTestId("check-verdict")).toHaveCount(0);

  await page.getByTestId("where-find").click();
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-progress")).toBeVisible();
  // Only one of them works: the check waits, and says so.
  await expect(page.getByTestId("check-held")).toBeVisible();
  await expect(page.getByTestId("check-bar")).toHaveCount(0);
  await expect.poll(async () => Number(await page.getByTestId("where-bar").getAttribute("aria-valuenow")), { timeout: 90_000 }).toBeGreaterThan(0);

  // Called off: the check picks up, and when it comes to nothing the search stays where it is.
  await page.getByTestId("where-cancel").click();
  await expect(page.getByTestId("check-held")).toHaveCount(0);
  await expect(page.getByTestId("check-progress")).toBeVisible();
  const search = await page.getByTestId("where-search").boundingBox();
  await expect(page.getByTestId("check-verdict")).toHaveText("No aircraft sound found.", { timeout: 170_000 });
  await expect(page.getByTestId("check")).toContainText("does not make the file safe");
  await expect(page.getByTestId("where-find")).toBeVisible();
  expect(await page.getByTestId("where-search").boundingBox()).toEqual(search);
  await expect(page.getByTestId("check-clean")).toHaveCount(0);
});

test("the tones a search finds show in the check's place, and after the answer nothing runs again until the visitor asks", async ({ page }, info) => {
  const wav = info.outputPath("flyovers.wav");
  writeFileSync(wav, await sceneWav());
  // How many times the check's worker started.
  await page.addInitScript(() => {
    const Real = window.Worker;
    const seen = window as unknown as { checks: number };
    seen.checks = 0;
    window.Worker = class extends Real {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes("check")) seen.checks++;
      }
    };
  });
  const checks = () => page.evaluate(() => (window as unknown as { checks: number }).checks);
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("check-progress")).toBeVisible();
  await page.getByTestId("where-find").click();
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("check-held")).toBeVisible();
  await details(page);
  await expect(page.getByTestId("check-tones").locator("li").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("where-verdict")).toBeVisible({ timeout: 170_000 });
  await expect(page.getByTestId("check-held")).toHaveCount(0);
  // No count: the search cuts tones differently, and the check's own number comes when it runs.
  await expect(page.getByTestId("check-verdict")).toHaveText(/^(An aircraft sound|Aircraft sounds) in this file\.$/);
  await details(page);
  await expect(page.getByTestId("check-fold").locator("summary")).toHaveText(/^See the sounds? in this file$/);
  const started = await checks();
  expect(started).toBeGreaterThan(0);
  await page.waitForTimeout(5000);
  expect(await checks()).toBe(started);
  await expect(page.getByTestId("check-progress")).toHaveCount(0);
  // Asked: it finds its own tones and takes them out, in one go, in the button's place.
  const button = await page.getByTestId("check-clean").boundingBox();
  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-progress")).toBeVisible();
  expect((await page.getByTestId("check-progress").boundingBox())!.y).toBeLessThan(button!.y + button!.height);
  await expect.poll(checks).toBe(started + 1);
  // It counts its own, then goes straight on to taking them out, with no second click. The rest of cleaning
  // is check.spec's, on a shorter file: on CI's runners this one would take minutes.
  await expect(page.getByTestId("check-progress")).toContainText(/Taking the sound out|Checking again|Writing the cleaned file/, { timeout: 120_000 });
  await expect(page.getByTestId("check-verdict")).toHaveText(/^(An aircraft sound|\d+ aircraft sounds) in this file\.$/);
});

/**
 * The shape of a real hour: dozens of tones. The finder keeps a couple a chunk, so sixty real ones take an
 * hour of sound and minutes of it: here the check's worker alone is stood in for, the page and the search are real.
 * Sixty tones come as the check goes, and the end when the test calls `finishCheck`.
 */
async function sixtyTones(page: Page) {
  await page.addInitScript(() => {
    const Real = window.Worker;
    const toneOf = (i: number) => {
      const start = 30 + i * 58;
      const times = Float64Array.from({ length: 160 }, (_, k) => start + k * 0.25);
      const freq = Float32Array.from({ length: 160 }, (_, k) => (90 + (i % 9) * 30) * (1 + 0.1 * Math.tanh(-(k - 80) / 30)));
      return { times, freq, confidence: 5 + (i * 7) % 40 };
    };
    const seen = Array.from({ length: 60 }, (_, i) => {
      const tone = toneOf(i);
      return { tone, view: { start: tone.times[0] - 10, end: tone.times[159] + 10, lo: tone.freq[159] * 0.8, hi: tone.freq[0] * 1.2 } };
    });
    class Check {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: unknown = null;
      postMessage(request: { type: string }) {
        const blank = (s: (typeof seen)[number]) => ({ ...s, before: { ...s.view, width: 1, height: 1, cells: new Uint8Array(1) } });
        if (request.type === "clean") {
          const cleaned = seen.map((s) => ({ ...s, gone: true }));
          setTimeout(() => this.onmessage?.({ data: { type: "cleaned", cleaned, left: [], file: new Blob([new Uint8Array(44)]), extension: "wav" } }), 50);
          return;
        }
        setTimeout(() => this.onmessage?.({ data: { type: "tones", duration: 3600, tones: seen } }), 50);
        (window as unknown as { finishCheck: () => void }).finishCheck = () =>
          this.onmessage?.({ data: { type: "found", duration: 3600, found: seen.map(blank) } });
      }
      terminate() {}
    }
    window.Worker = function (url: string | URL, options?: WorkerOptions) {
      return String(url).includes("where") ? new Real(url, options) : new Check();
    } as unknown as typeof Worker;
  });
}

test("sixty tones: the strongest three, the others a tap away and not drawn, and the page stays short, before, during and after a search", async ({ page }, info) => {
  const SCREEN = 844;
  const height = () => page.evaluate(() => document.documentElement.scrollHeight);
  const drawn = page.locator('[data-testid="check-tones"] canvas, [data-testid="check-others"] canvas');
  const wav = info.outputPath("scene.wav");
  writeFileSync(wav, await sceneWav());
  await sixtyTones(page);
  await page.setViewportSize({ width: 390, height: SCREEN });
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);

  // As they are found, a tap away.
  await details(page);
  await expect(page.getByTestId("check-tones").locator("li")).toHaveCount(3, { timeout: 60_000 });
  await expect(drawn).toHaveCount(3);
  expect(await height()).toBeLessThan(3 * SCREEN);
  // No count yet: pieces of one tone may still be joined.
  await expect(page.getByTestId("check-all").locator("summary")).toHaveText("See the sounds found so far");

  // Found: the count stays in one line, and so does the rest.
  await page.evaluate(() => (window as unknown as { finishCheck: () => void }).finishCheck());
  await expect(page.getByTestId("check-verdict")).toHaveText("60 aircraft sounds that could place this file.");
  await expect(drawn).toHaveCount(3);
  // The strongest, in the file's order.
  const captions = await page.getByTestId("check-tones").locator("li p").allInnerTexts();
  expect(captions).toEqual([...captions].sort());
  await expect(page.getByTestId("where-scope")).toBeVisible();
  expect(await height()).toBeLessThan(3 * SCREEN);
  await shoot(page, "where-sixty");

  // A tap away, all of them; closed, they go.
  const all = page.getByTestId("check-all").locator("summary");
  await expect(all).toHaveText("See all 60 tones");
  await all.click();
  await expect(drawn).toHaveCount(60);
  await all.click();
  await expect(drawn).toHaveCount(3);

  await page.getByTestId("where-find").click();
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-progress")).toBeVisible();
  await expect(drawn).toHaveCount(3);
  await shoot(page, "where-sixty-searching");
  // The form is open too.
  expect(await height()).toBeLessThan(4 * SCREEN);

  // Under an answer they are all put away, with the same line as on a shorter file.
  await expect(page.getByTestId("where-verdict")).toBeVisible({ timeout: 170_000 });
  await expect(drawn).toHaveCount(0);
  await details(page);
  await expect(drawn).toHaveCount(0);
  await expect(page.getByTestId("check-fold").locator("summary")).toHaveText("See the 60 sounds in this file");
  await shoot(page, "where-sixty-answer");
});

test("sixty tones taken out: before and after for the three, and the others from the same list", async ({ page }, info) => {
  const wav = info.outputPath("scene.wav");
  writeFileSync(wav, await sceneWav());
  await sixtyTones(page);
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await details(page);
  await expect(page.getByTestId("check-tones").locator("li")).toHaveCount(3, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as { finishCheck: () => void }).finishCheck());
  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-verdict")).toHaveText("The sounds are gone.", { timeout: 90_000 });
  await expect(page.getByTestId("check-download")).toBeVisible();
  const items = page.getByTestId("check-tones").locator("li");
  await expect(items).toHaveCount(3);
  await expect(items.first().locator("canvas")).toHaveCount(2);
  await page.getByTestId("check-all").locator("summary").click();
  await expect(page.getByTestId("check-others").locator("li")).toHaveCount(57);
  await expect(page.getByTestId("check-others").locator("li").first().locator("canvas")).toHaveCount(2);
});

test("on a wide screen the map takes the whole width, and under the answer each plane has its row", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const wav = info.outputPath("flyovers.wav");
  writeFileSync(wav, await sceneWav());
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await page.getByTestId("where-find").click();
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toBeVisible({ timeout: 170_000 });
  const result = (await page.getByTestId("where-result").boundingBox())!;
  const map = (await page.getByTestId("place-map").boundingBox())!;
  expect(map.width).toBe(result.width);
  const planes = page.getByTestId("answer-plane");
  const boxes = await planes.evaluateAll((items) => items.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
  expect(boxes[0].y).toBeGreaterThanOrEqual(map.y + map.height);
  for (const [i, box] of boxes.entries()) {
    expect(box.width).toBe(result.width);
    if (i) expect(box.y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/where-wide.jpg`, type: "jpeg", quality: 70, fullPage: true });
});

test.describe("the end of a search on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function search(page: Page, wav: string) {
    writeFileSync(wav, await sceneWav());
    await page.goto("/where");
    await page.getByTestId("where-file").setInputFiles(wav);
    await page.getByTestId("where-find").click();
    await fillIn(page);
    await page.getByTestId("where-search").click();
  }

  test("the verdict comes into view, on the first screen, and the answer holds still", async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await search(page, info.outputPath("one-pass.wav"));
    const verdict = page.getByTestId("where-verdict");
    await expect(verdict).toBeFocused({ timeout: 170_000 });
    const y = (await verdict.boundingBox())!.y;
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(844 / 2);
    expect(await verdict.evaluate((el) => el.getBoundingClientRect().top + window.scrollY)).toBeLessThan(844);
    // Here the map falls back to its diagram, whose caption is another length: what is above it holds, and it stays in the card.
    const held = ["where-verdict", "where-share"];
    const map = async () => (await page.getByTestId("place-map").boundingBox())!;
    const before = await rectsOf(page, held);
    const { x, y: mapY, width } = await map();
    await expect(page.getByTestId("place-map")).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
    expect(await rectsOf(page, held)).toEqual(before);
    expect(await map()).toMatchObject({ x, y: mapY, width });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shoot(page, "where-phone-answer");
  });

  test("a visitor who has scrolled away stays where they are", async ({ page }, info) => {
    await search(page, info.outputPath("one-pass.wav"));
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    const verdict = page.getByTestId("where-verdict");
    await expect(verdict).toBeVisible({ timeout: 170_000 });
    await expect(verdict).not.toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test("the Hz labels have a dark backing", async ({ page }, info) => {
  const wav = info.outputPath("two-passes.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("where-verdict")).toBeVisible({ timeout: 90_000 });
  await details(page);
  await page.getByTestId("check-fold").locator("summary").click();
  const label = page.getByTestId("check-tones").locator("span", { hasText: " Hz" }).first();
  await expect(label).toBeVisible({ timeout: 90_000 });
  expect(await label.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
});

for (const [name, width, height] of [["a computer", 1440, 900], ["a phone", 390, 844]] as const) {
  test(`on ${name}, nothing moves from listening to "can't tell", in English and in French`, async ({ page }, info) => {
    const wav = info.outputPath("two-passes.wav");
    writeFileSync(wav, await sceneWav(90));
    await page.setViewportSize({ width, height });
    for (const [path, words] of [["/where", "Can't tell where this was filmed"], ["/fr/where", "Impossible de dire où ça a été filmé"]]) {
      await page.goto(path);
      await page.getByTestId("where-file").setInputFiles(wav);
      await expect(page.getByTestId("check-progress")).toBeVisible();
      const before = await rectsOf(page, STAY);
      await expect(page.getByTestId("where-verdict")).toHaveText(words, { timeout: 90_000 });
      expect(await rectsOf(page, STAY)).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  });
}

test("the home is the file's door: a drop goes straight into the flow, and the heading does not move", async ({ page }, info) => {
  const wav = info.outputPath("two-passes.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Where was this filmed?");
  await shoot(page, "home");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const heading = await page.locator("h1").boundingBox();
  const door = await page.getByTestId("door").boundingBox();
  // A computer sees the way to a phone only behind the second door.
  await expect(page.getByTestId("qr")).toHaveCount(0);
  await page.getByTestId("listen").click();
  await expect(page.getByTestId("qr")).toBeVisible();
  await expect(page.getByTestId("listen-here")).toBeVisible();
  await shoot(page, "home-second-door");
  // That click scrolled the home: the file still opens from the top, the heading where it was.
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page).toHaveURL(/\/where$/);
  await expect(page.getByTestId("where-name")).toHaveText("two-passes.wav");
  await expect.poll(() => page.locator("h1").boundingBox()).toEqual(heading);
  const card = await page.getByTestId("where").boundingBox();
  // In line with the door, and higher up: the lead has given way.
  expect([card!.x, card!.width]).toEqual([door!.x, door!.width]);
  expect(card!.y).toBeLessThan(door!.y);
  await expect(page.getByTestId("answer")).toBeVisible();
});

test("the home takes a drop anywhere", async ({ page }) => {
  await page.goto("/");
  // Again until the page has hydrated: on a loaded machine the first drop can come before it.
  await expect(async () => {
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(64)], "dropped.wav", { type: "audio/wav" }));
      for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page).toHaveURL(/\/where$/, { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
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
  const wav = info.outputPath("two-passes.wav");
  writeFileSync(wav, await sceneWav(90));
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await expect(page.getByTestId("check-verdict")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("check-clean")).toBeEnabled();
  await details(page);
  await expect(page.getByTestId("where-offline")).toContainText("not connected yet");
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
  await expect(page.getByTestId("check-verdict")).toBeVisible({ timeout: 90_000 });
  await shoot(page, "where-fr-tones");
  await page.getByTestId("where-find").click();
  await fillIn(page);
  await expect(page.getByTestId("where-days")).toContainText("les vols d'un jour arrivent le lendemain");
  await shoot(page, "where-fr-form");
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText(/^Probablement filmé près de /, { timeout: 170_000 });
  await shoot(page, "where-fr-found");
});

test("the French best guess, for the screenshots", async ({ page }, info) => {
  test.skip(!SHOTS || !!process.env.NO_ARCHIVE, "screenshots only");
  const wav = info.outputPath("scene.wav");
  writeFileSync(wav, await sceneWav());
  await withoutTheFlag(page);
  await page.goto("/fr/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await page.getByTestId("where-find").click();
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-verdict")).toHaveText(/^Probablement filmé près de /, { timeout: 170_000 });
  await details(page);
  await expect(page.getByTestId("where-said")).toContainText("Un lieu n'est nommé que si au moins trois avions");
  await expect(page.getByTestId("where-place-name")).toContainText(/^Vers .+, Arizona, États-Unis$/);
  await shoot(page, "where-fr-best-guess");
});
