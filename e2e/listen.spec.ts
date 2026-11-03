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
  // The names and photo services answer nothing: the page must still name planes from the flight data alone.
  await page.route("https://api.adsbdb.com/**", (route) => route.fulfill({ status: 404, json: { response: "unknown" } }));
  // No photo, except for screenshots (SHOTS), where a real one shows the layout with a photo.
  const photo = process.env.SHOTS
    ? { src: "https://t.plnspttrs.net/08020/1984890_68b722e151_280.jpg", width: 498, height: 280, link: "https://www.planespotters.net/photo/1984890", photographer: "Liu" }
    : null;
  await page.route("**/api/photo*", (route) => route.fulfill({ json: { photo } }));
  await page.route("**/api/aircraft*", async (route) => {
    const micAt = await page.evaluate(() => (window as unknown as { __micAt?: number }).__micAt);
    if (!micAt) return route.fulfill({ json: { now: Date.now(), aircraft: [] } });
    const elapsed = (Date.now() - micAt) / 1000;
    let latest = polls[0];
    for (const p of polls) if (p.t <= elapsed) latest = p;
    return route.fulfill({ json: { now: Math.round(micAt + latest.t * 1000), aircraft: latest.poll.aircraft } });
  });

  await page.goto("/");
  // First the sky: before the microphone opens the replay has no plane yet, so the page says so.
  await page.getByTestId("listen").click();
  await expect(page.getByTestId("sky-title")).toHaveText("No plane within 30 km", { timeout: 30_000 });
  await page.getByTestId("start").click();
  await expect(page.getByTestId("timer")).toBeVisible({ timeout: 30_000 });
  // Once the plane shows up the page waits for it by name, then stops on its own after it passed.
  await expect(page.getByTestId("sky-title")).toHaveText(/^Cessna 172 Skyhawk is (coming|passing)$/, { timeout: 30_000 });
  await expect(page.getByTestId("sky-list")).toContainText("Cessna 172 Skyhawk");
  if (process.env.SHOTS) {
    await page.screenshot({ path: `${process.env.SHOTS}/recording-desktop.jpg`, quality: 70, scale: "css", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.SHOTS}/recording-phone.jpg`, quality: 70, scale: "css", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await expect(page.getByTestId("verdict")).toHaveText("It was a Cessna 172 Skyhawk.", { timeout: 150_000 });
  await expect(page.getByTestId("identity")).toHaveText("F-GDEM");
  await expect(page.getByTestId("facts")).toContainText("for its sound to reach you");

  // Give it to the dataset. The Blob store is mocked: what matters is what leaves the page.
  let sent = "";
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "PUT, OPTIONS" };
  await page.route("**/api/donate", (route) => route.fulfill({ json: { type: "blob.generate-client-token", clientToken: "vercel_blob_client_teststore_e30" } }));
  await page.route(/vercel\.com\/api\/blob/, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    sent = route.request().postDataBuffer()?.toString("utf8") ?? "";
    const pathname = "donations/v1/recording-e2eTest42.json";
    return route.fulfill({ headers: cors, json: { url: `https://teststore.private.blob.vercel-storage.com/${pathname}`, downloadUrl: "", pathname, contentType: "application/json", contentDisposition: "inline" } });
  });
  await expect(page.getByTestId("donate-heard")).toHaveValue(fixture().target);
  // SHOTS=<dir>: the real result with its donation form, at desktop and phone widths.
  if (process.env.SHOTS) {
    await page.locator("figure img[data-loaded]").waitFor({ timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.SHOTS}/found-desktop.jpg`, quality: 70, scale: "css" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.SHOTS}/found-phone.jpg`, quality: 70, scale: "css" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("donate").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SHOTS}/donate-desktop.jpg`, quality: 70, scale: "css", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.SHOTS}/donate-phone.jpg`, quality: 70, scale: "css", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await expect(page.getByTestId("donate-send")).toBeDisabled();
  await page.getByTestId("donate-consent").check();
  await page.getByTestId("donate-send").click();
  await expect(page.getByTestId("donated")).toContainText("e2eTest42", { timeout: 30_000 });
  const donation = JSON.parse(sent) as { anonymous: boolean; recording: { listener: { lat: number; lon: number }; start: number }; truth: { heard: string } };
  expect(donation.anonymous).toBe(true);
  expect(donation.recording.listener).toEqual({ lat: 0, lon: 0, elevation: 0 });
  expect(donation.recording.start).toBe(946_684_800);
  expect(donation.truth.heard).toMatch(/^x\d\d$/);
  const flightData = JSON.stringify({ ...donation, recording: { ...donation.recording, wav: "" } });
  expect(flightData).not.toContain(fixture().target);
  expect(flightData).not.toContain(callsign);
  expect(flightData).not.toContain("48.77");
});

test("the sky says which plane to wait for, before the microphone", async ({ page }) => {
  const { polls } = fixture();
  await page.route("**/api/weather*", (route) => route.fulfill({ json: { elevation: 160, temperatureC: 15 } }));
  await page.route("https://api.adsbdb.com/**", (route) => route.fulfill({ status: 404, json: { response: "unknown" } }));
  // The replay starts when the page first asks: the Cessna is 48 s from its closest point, 690 m away.
  let first = 0;
  await page.route("**/api/aircraft*", (route) => {
    first ||= Date.now();
    const elapsed = (Date.now() - first) / 1000;
    let latest = polls[0];
    for (const p of polls) if (p.t <= elapsed) latest = p;
    return route.fulfill({ json: { now: Math.round(first + latest.t * 1000), aircraft: latest.poll.aircraft } });
  });
  await page.goto("/");
  await page.getByTestId("listen").click();
  await expect(page.getByTestId("sky-title")).toHaveText(/^Cessna 172 Skyhawk passes \d+ m from you in 0:[2-5]\d\.$/, { timeout: 30_000 });
  await expect(page.getByTestId("start")).toHaveText("Start listening");
  await expect(page.getByTestId("sky-list").locator("li").first()).toContainText("closest in");
  if (process.env.SHOTS) {
    await page.screenshot({ path: `${process.env.SHOTS}/sky-desktop.jpg`, quality: 70, scale: "css", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.SHOTS}/sky-phone.jpg`, quality: 70, scale: "css", fullPage: true });
  }
});

test("the example ends on a strong match", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("example").click();
  await expect(page.getByTestId("verdict")).toHaveText("It was a Cessna 172 Skyhawk.", { timeout: 60_000 });
  await expect(page.getByTestId("facts")).toContainText("the Doppler effect");
  await page.getByTestId("curve-toggle").click();
  await expect(page.getByTestId("curve-toggle")).toHaveText("Hide the curve");
});
