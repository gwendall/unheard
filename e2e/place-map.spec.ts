import { expect, test, type Page } from "@playwright/test";

// The map in a real Chromium, from the real bucket: serve the app with the archive set, and point
// BASE_URL at it.
//   NEXT_PUBLIC_HISTORY_URL=https://unheard-history.t3.tigrisbucket.io machine serve -- pnpm exec next dev -p {port}
// The page's promise is that nothing is sent: any request to another host fails these tests.

const BUCKET = "unheard-history.t3.tigrisbucket.io";
const SHOTS = process.env.SHOTS;

// The Mac's own GPU when there is one: software WebGL pins a core and draws this far too slowly.
test.use({ launchOptions: { args: process.platform === "darwin" ? ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-webgl"] : [] } });

/** Every host the page asks, and what it asks. */
function watch(page: Page) {
  const urls: string[] = [];
  const failures: string[] = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) urls.push(r.url());
  });
  page.on("pageerror", (e) => failures.push(e.message));
  return { urls, failures, others: (own: string) => [...new Set(urls.map((u) => new URL(u).host))].filter((h) => h !== own && h !== BUCKET) };
}

const figure = (page: Page) => page.getByTestId("place-map");
const ready = (page: Page) => expect(figure(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
const failed = (page: Page) => expect(figure(page)).toHaveAttribute("data-state", "failed", { timeout: 60_000 });
const zoom = async (page: Page) => Number(await figure(page).getAttribute("data-zoom"));
const host = (page: Page) => new URL(page.url()).host;
const boxHeight = async (page: Page) => (await figure(page).locator("> div").first().boundingBox())!.height;

test("the answer on a real map, and no host but ours", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/en/dev-map");
  await ready(page);
  await expect(page.getByTestId("place-name")).toHaveText("Oyster Bay, New York");

  expect(seen.others(host(page))).toEqual([]);
  expect(seen.urls.some((u) => u.includes(".pmtiles"))).toBe(true);
  expect(seen.urls.some((u) => u.includes("/map/fonts/"))).toBe(true);
  expect(seen.urls.some((u) => u.includes("/places/v1/"))).toBe(true);
  expect(seen.failures).toEqual([]);

  await expect(page.getByTestId("place-map-credit")).toContainText("OpenStreetMap");
  await expect(page.getByTestId("place-map-credit")).toContainText("GeoNames");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/map-desktop.png`, fullPage: true });

  // Zoomed in on the spot, the finest tiles the page asks for, still only from the bucket.
  await page.getByTestId("place-map-spot").click();
  await expect.poll(() => zoom(page)).toBe(15);
  await page.waitForTimeout(3000);
  expect(seen.others(host(page))).toEqual([]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/map-spot-desktop.png`, fullPage: true });
});

test("reads the tiles by range, without a body it does not need", async ({ page }) => {
  const ranges: { status: number; bytes: number }[] = [];
  page.on("response", (r) => {
    if (r.url().includes(".pmtiles")) ranges.push({ status: r.status(), bytes: Number(r.headers()["content-length"]) });
  });
  await page.goto("/en/dev-map");
  await ready(page);
  expect(ranges.length).toBeGreaterThan(0);
  for (const r of ranges) {
    expect(r.status).toBe(206);
    expect(r.bytes).toBeLessThan(2_000_000);
  }
});

test("fits the phone, and keeps its height while it loads", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en/dev-map");
  await expect(figure(page)).toBeVisible();
  const before = await boxHeight(page);
  await ready(page);
  expect(await boxHeight(page)).toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const box = (await figure(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  for (const id of ["place-map-in", "place-map-out", "place-map-spot"]) {
    const button = (await page.getByTestId(id).boundingBox())!;
    expect(Math.min(button.width, button.height)).toBeGreaterThanOrEqual(44);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/map-phone.png`, fullPage: true });
});

test("works by keyboard", async ({ page }) => {
  await page.goto("/en/dev-map");
  await ready(page);
  await page.locator("canvas").focus();
  const start = await zoom(page);
  await page.keyboard.press("=");
  await expect.poll(() => zoom(page)).toBeGreaterThan(start);
  const inner = await zoom(page);
  await page.keyboard.press("-");
  await expect.poll(() => zoom(page)).toBeLessThan(inner);
  // The buttons are real buttons, with their names, in reach of the Tab key.
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  await zoomIn.focus();
  const before = await zoom(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => zoom(page)).toBeGreaterThan(before);
});

test("respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/en/dev-map");
  await ready(page);
  await page.getByTestId("place-map-spot").click();
  // No animation: there by the next frames, where the animated move takes 500 ms.
  await expect.poll(() => zoom(page), { timeout: 200, intervals: [20] }).toBe(15);
});

test("falls back to the diagram with no WebGL, and asks for no map at all", async ({ page }) => {
  await page.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return /webgl/.test(type) ? null : (real as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof real;
  });
  const seen = watch(page);
  await page.goto("/en/dev-map");
  await failed(page);
  await expect(page.getByTestId("where-plot")).toBeVisible();
  await expect(page.getByTestId("place-map-credit")).toContainText("plain plot");
  expect(seen.urls.filter((u) => u.includes(".pmtiles") || u.includes("/map/"))).toEqual([]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/map-no-webgl.png`, fullPage: true });
});

test("falls back to the diagram when the tiles cannot be read, in the same box", async ({ page }) => {
  await page.route("**/*.pmtiles", (route) => route.abort());
  await page.goto("/en/dev-map");
  await expect(figure(page)).toBeVisible();
  const before = await boxHeight(page);
  await failed(page);
  await expect(page.getByTestId("where-plot")).toBeVisible();
  expect(await boxHeight(page)).toBe(before);
});

test("speaks French", async ({ page }) => {
  await page.goto("/fr/dev-map");
  await ready(page);
  await expect(page.getByTestId("place-map-credit")).toContainText("Noms de lieux");
  await expect(page.getByRole("button", { name: "Zoomer", exact: true })).toBeVisible();
});

test("the home and the search load none of it", async ({ page }) => {
  const heavy: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes(".pmtiles") || r.url().includes("/map/") || r.url().includes("/places/")) heavy.push(r.url());
    if (!/javascript/.test(r.headers()["content-type"] ?? "")) return;
    const body = await r.text().catch(() => "");
    if (body.includes("MapLibre GL JS")) heavy.push(r.url());
  });
  await page.goto("/");
  await page.waitForTimeout(3000);
  await page.goto("/where");
  await page.waitForTimeout(3000);
  expect(heavy).toEqual([]);
});
