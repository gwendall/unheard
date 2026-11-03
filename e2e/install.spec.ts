import { expect, test } from "@playwright/test";

// What a phone needs to keep Unheard on its home screen, and the tab icon.

test("the manifest and its icons are served", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const manifest = (await res.json()) as { start_url: string; display: string; icons: { src: string; sizes: string }[] };
  expect(manifest).toMatchObject({ start_url: "/", display: "standalone" });
  for (const icon of manifest.icons) {
    const png = await request.get(icon.src);
    expect(png.status(), icon.src).toBe(200);
    expect(png.headers()["content-type"]).toBe("image/png");
  }
});

test("pages link the tab icon, the iPhone icon and the manifest", async ({ page }) => {
  await page.goto("/fr");
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /\/icon\//);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /\/apple-icon/);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
});
