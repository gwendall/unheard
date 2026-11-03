import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Taking the tones out, end to end in a real Chromium: a file picked, its sound decoded by Web Audio,
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
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(FLYBY);
  await expect(page.getByTestId("check-verdict")).toHaveText(/^(An aircraft tone|\d+ aircraft tones) that could place this file\.$/, { timeout: 90_000 });
  await expect(page.getByTestId("check-tones").locator("li").first()).toContainText(/\d:\d\d to \d:\d\d in the file, \d+ to \d+ Hz/);

  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-verdict")).toHaveText(/^The tones? (is|are) gone\.$/, { timeout: 120_000 });
  await shoot(page, "check-cleaned");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("check-download").click()]);
  expect(download.suggestedFilename()).toBe("flyby-cleaned.wav");
  // The whole file, as long as it came in: 85 s of one channel at 48 kHz, 16 bits.
  expect(statSync(await download.path()).size).toBe(44 + 85 * 48_000 * 2);
});

test("the French page, for the screenshots", async ({ page }) => {
  test.skip(!SHOTS, "screenshots only");
  await page.goto("/fr/where");
  await page.getByTestId("where-file").setInputFiles(FLYBY);
  await expect(page.getByTestId("check-verdict")).toContainText("qui pourrai", { timeout: 90_000 });
  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-download")).toBeVisible({ timeout: 120_000 });
  await shoot(page, "check-fr-cleaned");
});
