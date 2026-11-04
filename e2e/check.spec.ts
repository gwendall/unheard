import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { workersFor } from "../lib/client/pool";

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

/** Colours on a canvas: a tone's picture has about ten thousand, the dark one that waits for it, with the curve's rails, some hundreds. */
const coloursOf = (canvas: Locator) =>
  canvas.evaluate((c: HTMLCanvasElement) => {
    const { data } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    return seen.size;
  });
const MANY = 2000;

test("finds the plane's tone in a file, takes it out, and hands back the cleaned sound", async ({ page }) => {
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(FLYBY);
  await expect(page.getByTestId("check-verdict")).toHaveText(/^(An aircraft tone|\d+ aircraft tones) that could place this file\.$/, { timeout: 90_000 });
  const first = page.getByTestId("check-tones").locator("li").first();
  await expect(first).toContainText(/\d:\d\d to \d:\d\d in the file, \d+ to \d+ Hz/);
  // The verdict does not wait for the pictures: they come after it, without being asked twice.
  await expect.poll(() => coloursOf(first.locator("canvas").first()), { timeout: 30_000 }).toBeGreaterThan(MANY);

  await page.getByTestId("check-clean").click();
  await expect(page.getByTestId("check-verdict")).toHaveText(/^The tones? (is|are) gone\.$/, { timeout: 120_000 });
  for (const picture of [first.locator("canvas").first(), first.locator("canvas").last()]) await expect.poll(() => coloursOf(picture), { timeout: 30_000 }).toBeGreaterThan(MANY);
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

test.describe("on a phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } });

  test("the pool goes by a phone's memory: no worker to take tones out at 48 kHz", async ({ page, browser }) => {
    const cores = await page.evaluate(() => navigator.hardwareConcurrency);
    const seconds = 85;
    await page.goto("/where");
    const workers = page.getByTestId("check");
    // What is really running: the check's own worker, and the pool's, if any.
    const cdp = await browser.newBrowserCDPSession();
    const running = async () => (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "worker").length;

    await page.getByTestId("where-file").setInputFiles(FLYBY);
    await expect(page.getByTestId("check-verdict")).toBeVisible({ timeout: 90_000 });
    await expect(workers).toHaveAttribute("data-workers", String(workersFor({ cores, phone: true }, { kind: "find", seconds })));

    await page.getByTestId("check-clean").click();
    const expected = workersFor({ cores, phone: true }, { kind: "clean", seconds, rate: 48_000 });
    expect(expected).toBe(0);
    await expect(workers).toHaveAttribute("data-workers", "0");
    let most = 0;
    while (!(await page.getByTestId("check-download").isVisible())) {
      most = Math.max(most, await running());
      await page.waitForTimeout(100);
    }
    expect(most).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("check-verdict")).toHaveText(/^The tones? (is|are) gone\.$/);
  });
});

test("a computer's pool goes by its cores", async ({ page }) => {
  const cores = await page.evaluate(() => navigator.hardwareConcurrency);
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(FLYBY);
  await expect(page.getByTestId("check-verdict")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("check")).toHaveAttribute("data-workers", String(workersFor({ cores }, { kind: "find", seconds: 85 })));
});
