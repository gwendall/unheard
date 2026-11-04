import { copyFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { cardFilled, fillIn, sceneWav } from "./where-scene";

// A result's card from the real map, in a real Chromium. The where spec covers the same flow with
// the diagram; this one has its own file because a browser's arguments cannot change within one.

const SHOTS = process.env.SHOTS;
const BUCKET = "unheard-history.t3.tigrisbucket.io";

// The Mac's own GPU when there is one: software WebGL draws far too slowly.
test.use({ launchOptions: { args: process.platform === "darwin" ? ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-webgl"] : [] } });

test("the card holds the map as it stands on the screen, made on the click, and nothing is sent", async ({ page }, info) => {
  const wav = info.outputPath("one-pass.wav");
  writeFileSync(wav, await sceneWav(90));
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.method() !== "HEAD") sent.push(`${r.method()} ${r.url()}`);
  });
  // The local archive has flights and no map: the map's files come from the real bucket.
  await page.route("**/dev-history/map/**", async (route) => {
    const url = `https://${BUCKET}/map/${route.request().url().split("/dev-history/map/")[1]}`;
    try {
      await route.fulfill({ response: await route.fetch({ url }) });
    } catch {
      await route.abort();
    }
  });
  await page.goto("/where");
  await page.getByTestId("where-file").setInputFiles(wav);
  await page.getByTestId("where-find").click();
  await fillIn(page);
  await page.getByTestId("where-search").click();
  await expect(page.getByTestId("where-share")).toBeVisible({ timeout: 170_000 });
  const map = page.getByTestId("place-map");
  await expect(map).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  const before = await map.getAttribute("data-center");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("where-share").getByRole("button").click()]);
  const png = await download.path();
  if (SHOTS) copyFileSync(png, `${SHOTS}/where-card-map.png`);
  expect(sent).toEqual([]);
  expect(await map.getAttribute("data-center")).toBe(before);
  expect(await cardFilled(page, png)).toBeGreaterThan(0.8);
});
