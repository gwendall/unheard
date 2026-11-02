import { test } from "@playwright/test";

// Screenshots for a human review at desktop and phone widths: SHOTS=<dir> pnpm e2e screens
const dir = process.env.SHOTS;

for (const [name, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
  test(`screens at ${name} width`, async ({ page }) => {
    test.skip(!dir, "set SHOTS to a folder to take screenshots");
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.screenshot({ path: `${dir}/hero-${name}.jpg`, quality: 70, scale: "css" });
    await page.getByTestId("example").click();
    await page.getByTestId("verdict").waitFor({ timeout: 60_000 });
    await page.screenshot({ path: `${dir}/result-${name}.jpg`, quality: 70, scale: "css", fullPage: true });
    await page.getByTestId("curve-toggle").click();
    await page.getByTestId("curve-toggle").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/curve-${name}.jpg`, quality: 70, scale: "css" });
  });
}
