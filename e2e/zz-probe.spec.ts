import { expect, test } from "@playwright/test";

// Throwaway: proves the red path of the e2e job. Never merged.
test("probe: passes only on its retry", () => {
  expect(test.info().retry).toBe(1);
});

test("probe: always fails, on the real page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("probe: not this heading", { timeout: 2_000 });
});
