import { expect, test } from "@playwright/test";

// The site in French: its own address, the bare address for a French browser, and the example
// through to its verdict.

test("the bare address speaks the browser's language", async ({ browser }) => {
  for (const [locale, title, lang] of [
    ["fr-FR", "Il y a un avion que vous n'entendez pas.", "fr"],
    ["en-US", "There's a plane you can't hear.", "en"],
    ["de-DE", "There's a plane you can't hear.", "en"],
  ] as const) {
    const context = await browser.newContext({ locale });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("h1")).toHaveText(title);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      expect(new URL(page.url()).pathname).toBe("/");
    } finally {
      await context.close();
    }
  }
});

test("/fr is French whatever the browser, with a way back to English", async ({ page }) => {
  await page.goto("/fr");
  await expect(page.locator("h1")).toHaveText("Il y a un avion que vous n'entendez pas.");
  await expect(page.getByTestId("listen")).toHaveText("Écouter le ciel");
  await expect(page.getByTestId("proof")).toContainText("enregistrements de test");
  await page.getByRole("link", { name: "English" }).click();
  await expect(page.locator("h1")).toHaveText("There's a plane you can't hear.");
});

test("the example in French, through to its verdict", async ({ page }) => {
  await page.goto("/fr");
  await page.getByTestId("example").click();
  await expect(page.getByTestId("verdict")).toHaveText("C'était un Cessna 172 Skyhawk.", { timeout: 60_000 });
  await expect(page.getByTestId("facts")).toContainText("l'effet Doppler");
  await expect(page.getByTestId("hear-it")).toContainText("quatre fois plus vite");
});

test("an unknown language is a 404", async ({ request }) => {
  expect((await request.get("/de")).status()).toBe(404);
});
