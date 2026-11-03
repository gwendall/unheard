import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Poll } from "../lib/adsb";

// The fake microphone plays the flyby of listen.spec.ts while the replayed flight data leaves that
// plane out: the page must say it hears something the data does not have, and no more than that.
// Only the sky's small plane stays in the data: the others fall about as fast as the plane heard,
// and a line an aircraft of the data could follow at some tone is not told (GHOST.shape).
// SHOTS=<dir> also runs it in French and takes the block at desktop and phone widths.

const WAV = fileURLToPath(new URL("./fixtures/flyby.wav", import.meta.url));
const FAR_PLANE = "39a4e7";
type Fixture = { polls: { t: number; poll: Poll }[] };
const fixture = (): Fixture => JSON.parse(readFileSync(new URL("./fixtures/flyby-polls.json", import.meta.url), "utf8"));

test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "--autoplay-policy=no-user-gesture-required"] },
  permissions: ["microphone", "geolocation"],
  geolocation: { latitude: 48.7731, longitude: 2.1186, accuracy: 10 },
});

const LANGUAGES = [
  { lang: "en", locale: "en-GB", path: "/", words: "We hear something pass that the flight data does not have." },
  { lang: "fr", locale: "fr-FR", path: "/fr", words: "Nous entendons passer quelque chose que les données de vol n'ont pas." },
].slice(0, process.env.SHOTS ? 2 : 1);

for (const { lang, locale, path, words } of LANGUAGES) {
  test.describe(lang, () => {
    test.use({ locale });

    test("a plane missing from the flight data is told apart from the verdict", async ({ page }) => {
      const { polls } = fixture();
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
      await page.route("https://api.adsbdb.com/**", (route) => route.fulfill({ status: 404, json: { response: "unknown" } }));
      await page.route("**/api/photo*", (route) => route.fulfill({ json: { photo: null } }));
      await page.route("**/api/aircraft*", async (route) => {
        const micAt = await page.evaluate(() => (window as unknown as { __micAt?: number }).__micAt);
        if (!micAt) return route.fulfill({ json: { now: Date.now(), aircraft: [] } });
        const elapsed = (Date.now() - micAt) / 1000;
        let latest = polls[0];
        for (const p of polls) if (p.t <= elapsed) latest = p;
        return route.fulfill({ json: { now: Math.round(micAt + latest.t * 1000), aircraft: latest.poll.aircraft.filter((a) => a.hex === FAR_PLANE) } });
      });

      await page.goto(path);
      await page.getByTestId("listen").click();
      await page.getByTestId("start").click();
      await expect(page.getByTestId("timer")).toBeVisible({ timeout: 30_000 });
      // The pass is over by 1:10; the other planes of the sky may stop the recording on their own after that.
      const ghost = page.getByTestId("ghost");
      await expect(async () => {
        if (await ghost.count()) return;
        await expect(page.getByTestId("timer")).toHaveText(/^1:[1-9]\d/, { timeout: 1_000 });
        await page.getByTestId("stop").click({ timeout: 1_000 });
      }).toPass({ timeout: 150_000 });

      await expect(ghost).toContainText(words, { timeout: 150_000 });
      await expect(page.getByTestId("ghost-line")).toHaveCount(1);
      await expect(page.getByTestId("ghost-line")).toContainText(/1\d\d (to|à) \d\d Hz/);
      await expect(page.getByTestId("verdict")).not.toHaveText(/^(It was|C'était)/);

      if (process.env.SHOTS) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${process.env.SHOTS}/ghost-${lang}-desktop.jpg`, quality: 80, scale: "css", fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${process.env.SHOTS}/ghost-${lang}-phone.jpg`, quality: 80, scale: "css", fullPage: true });
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    });
  });
}
