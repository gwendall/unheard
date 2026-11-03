import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { Poll } from "../lib/adsb";

// "Somewhere else" end to end: the real page decodes a voice note from a file, polls the sky of
// the place picked (three real adsb.lol polls over Phoenix, replayed as if made now), plants the
// curves, and reads its own downloaded file back with analyze() at the spot it chose.

const VOICE = fileURLToPath(new URL("./fixtures/voice.wav", import.meta.url));
type Fixture = { centre: { lat: number; lon: number; elevation: number }; polls: Poll[] };
const fixture = (): Fixture => JSON.parse(readFileSync(new URL("./fixtures/elsewhere-polls.json", import.meta.url), "utf8"));

/** The recorded polls in order, each as if made just now: positions as recorded, the clock of today. */
async function replaySky(page: Page) {
  const { polls } = fixture();
  let asked = 0;
  await page.route("**/api/aircraft*", (route) => {
    const poll = polls[Math.min(asked++, polls.length - 1)];
    const shift = Date.now() - polls[polls.length - 1].now + (polls.length - 1) * 3000;
    return route.fulfill({ json: { now: poll.now + shift, aircraft: poll.aircraft } });
  });
  await page.route("**/api/weather*", (route) => route.fulfill({ json: { elevation: fixture().centre.elevation, temperatureC: 20 } }));
  await page.route("https://api.adsbdb.com/**", (route) => route.fulfill({ status: 404, json: { response: "unknown" } }));
  return () => asked;
}

async function shots(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${process.env.SHOTS}/${name}-desktop.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${process.env.SHOTS}/${name}-phone.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("a voice note gets the sky of another place, and Unheard's own analysis points there", async ({ page }) => {
  const polled = await replaySky(page);
  const { centre } = fixture();
  await page.goto("/");
  await expect(page.getByTestId("elsewhere-link")).toHaveAttribute("href", "/somewhere-else");
  await page.getByTestId("elsewhere-link").click();
  await expect(page.locator("h1")).toHaveText("Make your recording sound like it was made somewhere else.");
  await shots(page, "elsewhere-pick");

  await page.getByTestId("place-coords").click();
  await page.getByTestId("coords").fill(`${centre.lat}, ${centre.lon}`);
  await page.getByTestId("file").setInputFiles(VOICE);
  await expect(page.getByTestId("audio")).toContainText("voice.wav");
  await expect(page.getByTestId("audio")).toContainText("0:40");
  await page.getByTestId("make").click();
  await expect(page.getByTestId("elsewhere-step")).toContainText("Asking for the flights over 33.60°\u00a0N, 112.00°\u00a0W");

  // What someone running the video's method would conclude, then the proof from the file itself.
  await expect(page.getByTestId("elsewhere-title")).toHaveText(/^These curves point to 33\.60°\u00a0N, 112\.00°\u00a0W, at \d\d:\d\d UTC\.$/, { timeout: 120_000 });
  expect(polled()).toBe(3);
  await expect(page.getByTestId("elsewhere-spot")).toContainText("of the centre, where");
  await expect(page.getByTestId("proof-text")).toContainText(/says: “It was .+\.” Score \d+(\.\d)?\. Strong starts at 9/);
  await expect(page.getByTestId("added").locator("li").first()).toBeVisible();
  await expect(page.getByTestId("added")).toContainText("the one it points to");
  await shots(page, "elsewhere-result");

  // The file: a WAV as long as the voice note, at its rate.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download").click()]);
  expect(download.suggestedFilename()).toMatch(/^recording-\d{8}-\d{4}\.wav$/);
  const wav = readFileSync(await download.path());
  expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(wav.readUInt32LE(24)).toBe(48_000);
  expect(wav.length).toBe(44 + 40 * 48_000 * 2);
});

test("in French, the same page and its result", async ({ page }) => {
  test.skip(!process.env.SHOTS, "set SHOTS to a folder to take screenshots");
  await replaySky(page);
  const { centre } = fixture();
  await page.goto("/fr/somewhere-else");
  await page.getByTestId("place-coords").click();
  await page.getByTestId("coords").fill(`${centre.lat}, ${centre.lon}`);
  await page.getByTestId("file").setInputFiles(VOICE);
  await page.getByTestId("make").click();
  await expect(page.getByTestId("elsewhere-title")).toHaveText(/^Ces courbes désignent 33,60°\u00a0N, 112,00°\u00a0O, à \d\d:\d\d UTC\.$/, { timeout: 120_000 });
  await shots(page, "elsewhere-result-fr");
});

test("in French, at /fr/somewhere-else, and /en/somewhere-else goes to the English page", async ({ page }) => {
  await page.goto("/fr/somewhere-else");
  await expect(page.locator("h1")).toHaveText("Faites croire que votre enregistrement a été fait ailleurs.");
  await expect(page.getByTestId("make")).toHaveText("Le faire sonner comme à Athènes");
  await expect(page.getByTestId("make")).toBeDisabled();
  await shots(page, "elsewhere-pick-fr");
  await page.goto("/en/somewhere-else");
  expect(new URL(page.url()).pathname).toBe("/somewhere-else");
});
