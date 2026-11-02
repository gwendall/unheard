import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Poll } from "../lib/adsb";

// The production path end to end: the real page, Chromium's audio stack (worklet capture,
// resampling, time stamps), the polling loop and analyze(), fed by a fake microphone that plays
// a flyby and by flight data replayed in step with it.

const WAV = fileURLToPath(new URL("./fixtures/flyby.wav", import.meta.url));
type Fixture = { listener: { lat: number; lon: number; elevation: number }; target: string; callsign: string; polls: { t: number; poll: Poll }[] };
const fixture = (): Fixture => JSON.parse(readFileSync(new URL("./fixtures/flyby-polls.json", import.meta.url), "utf8"));

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "--autoplay-policy=no-user-gesture-required"] },
  permissions: ["microphone", "geolocation"],
  geolocation: { latitude: 48.7731, longitude: 2.1186, accuracy: 10 },
});

test("finds the plane in a recording made through the real page", async ({ page }) => {
  const { polls, callsign } = fixture();
  // The fake microphone starts its file when the stream opens: that moment is t = 0 of the fixture.
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    const open = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const stream = await open(c);
      (window as unknown as { __micAt: number }).__micAt = Date.now();
      return stream;
    };
  });
  await page.route("**/api/weather*", (route) => route.fulfill({ json: { elevation: 160, temperatureC: 15 } }));
  await page.route("**/api/aircraft*", async (route) => {
    const micAt = await page.evaluate(() => (window as unknown as { __micAt?: number }).__micAt);
    if (!micAt) return route.fulfill({ json: { now: Date.now(), aircraft: [] } });
    const elapsed = (Date.now() - micAt) / 1000;
    let latest = polls[0];
    for (const p of polls) if (p.t <= elapsed) latest = p;
    return route.fulfill({ json: { now: Math.round(micAt + latest.t * 1000), aircraft: latest.poll.aircraft } });
  });

  await page.goto("/");
  await page.getByTestId("listen").click();
  await expect(page.getByTestId("timer")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(62_000);
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("verdict")).toHaveText(`It was ${callsign}.`, { timeout: 90_000 });
});

test("the example ends on a strong match", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("example").click();
  await expect(page.getByTestId("verdict")).toHaveText("It was FGDEMO.", { timeout: 60_000 });
  await page.getByTestId("curve-toggle").click();
  await expect(page.getByTestId("curve-toggle")).toHaveText("Hide the curve");
});
