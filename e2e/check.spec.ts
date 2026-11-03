import { statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { encodeWav } from "../lib/bundle";
import { STANDARD_AIR } from "../lib/core/doppler";
import { synthesize } from "../lib/core/synth";

// The check page end to end in a real Chromium: a file picked, its sound decoded by Web Audio,
// the tones found in the worker, taken out, looked for again, and the cleaned WAV downloaded.
// The file is the listening test's flyby: a Cessna 172 at 92 Hz in noise, hum and rumble.

const FLYBY = fileURLToPath(new URL("./fixtures/flyby.wav", import.meta.url));
const SHOTS = process.env.SHOTS;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-desktop.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/${name}-phone.jpg`, quality: 70, scale: "css", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("finds the plane's tone in a file, takes it out, and hands back the cleaned sound", async ({ page }) => {
  await page.goto("/check");
  await expect(page.locator("h1")).toHaveText("Does your video give away where you are?");
  await expect(page.getByTestId("check-private")).toContainText("Your file never leaves this device");
  await shoot(page, "check-idle");

  await page.getByTestId("check-file").setInputFiles(FLYBY);
  await expect(page.getByTestId("check-verdict")).toHaveText(/^This recording holds (an aircraft tone|\d+ aircraft tones) that could place it\.$/, { timeout: 90_000 });
  await expect(page.getByTestId("check-tones").locator("li").first()).toContainText(/\d:\d\d to \d:\d\d in the file, \d+ to \d+ Hz/);
  await shoot(page, "check-found");

  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-verdict")).toHaveText(/^The tones? (is|are) gone\.$/, { timeout: 120_000 });
  await shoot(page, "check-cleaned");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("check-download").click()]);
  expect(download.suggestedFilename()).toBe("flyby-cleaned.wav");
  // The whole file, as long as it came in: 85 s of one channel at 48 kHz, 16 bits.
  expect(statSync(await download.path()).size).toBe(44 + 85 * 48_000 * 2);
});

test("says so when there is no aircraft tone, and never that the file is safe", async ({ page }, info) => {
  const noise = info.outputPath("street.wav");
  const samples = synthesize({ start: 0, duration: 30, sampleRate: 48_000, air: STANDARD_AIR, sources: [], noise: 1, rumble: 1, hum: [{ freq: 50, level: 0.4 }], seed: 3 });
  writeFileSync(noise, encodeWav(samples, 48_000));
  await page.goto("/check");
  await page.getByTestId("check-file").setInputFiles(noise);
  await expect(page.getByTestId("check-verdict")).toHaveText("No aircraft tone found.", { timeout: 60_000 });
  await expect(page.getByTestId("check")).toContainText("That does not make the file safe");
  await shoot(page, "check-none");
  await page.getByTestId("check-another").click();
  await expect(page.getByTestId("check-drop")).toBeVisible();
});

test("the French page, for the screenshots", async ({ page }) => {
  test.skip(!SHOTS, "screenshots only");
  await page.goto("/fr/check");
  await expect(page.locator("h1")).toHaveText("Votre vidéo dit où vous êtes ?");
  await shoot(page, "check-fr-idle");
  await page.getByTestId("check-file").setInputFiles(FLYBY);
  await expect(page.getByTestId("check-verdict")).toContainText("Cet enregistrement contient", { timeout: 90_000 });
  await shoot(page, "check-fr-found");
  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-download")).toBeVisible({ timeout: 120_000 });
  await shoot(page, "check-fr-cleaned");
});
