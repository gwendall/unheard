import { expect, test } from "@playwright/test";
import { LANG_COOKIE } from "../lib/locales";

// The languages the way every site of the family has them (next.config.ts): English at /, French
// at /fr, a first visit sent to the browser's first language, the menu's choice kept after that.

const EN = "Where was this filmed?";
const FR = "Où a-t-on filmé ça ?";

test("a first visit gets the browser's first language, at its own address", async ({ browser }) => {
  for (const [locale, title, lang, path] of [
    ["fr-FR", FR, "fr", "/fr"],
    ["en-US", EN, "en", "/"],
    ["de-DE", EN, "en", "/"],
  ] as const) {
    const context = await browser.newContext({ locale });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("h1")).toHaveText(title);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      expect(new URL(page.url()).pathname).toBe(path);
    } finally {
      await context.close();
    }
  }
});

test("the menu switches the language and the site keeps it", async ({ browser }) => {
  const context = await browser.newContext({ locale: "fr-FR" });
  try {
    const page = await context.newPage();
    await page.goto("/privacy");
    expect(new URL(page.url()).pathname).toBe("/fr/privacy");
    // English, picked in the header: the same page, and / stays English for this French browser.
    await page.getByTestId("language").getByRole("button", { name: "Langue" }).click();
    await page.getByRole("link", { name: "English" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    expect(new URL(page.url()).pathname).toBe("/privacy");
    await expect(page.locator("h1")).toHaveText("What is sent");
    expect((await context.cookies()).find((c) => c.name === LANG_COOKIE)?.value).toBe("en");
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText(EN);
    expect(new URL(page.url()).pathname).toBe("/");
    // Back to French from the foot of the page: / now sends to /fr.
    await page.getByTestId("language-footer").getByRole("button", { name: "Language" }).click();
    await page.getByRole("link", { name: "Français" }).click();
    await expect(page.locator("h1")).toHaveText(FR);
    await page.goto("/");
    expect(new URL(page.url()).pathname).toBe("/fr");
  } finally {
    await context.close();
  }
});

test("/en is / and /fr is French whatever the browser", async ({ page, request }) => {
  const en = await request.get("/en", { maxRedirects: 0 });
  expect(en.status()).toBe(308);
  expect(en.headers().location).toBe("/");
  await page.goto("/fr");
  await expect(page.locator("h1")).toHaveText(FR);
  await expect(page.getByTestId("listen")).toHaveText("Écouter le ciel");
  await expect(page.getByTestId("proof")).toContainText("enregistrements de test");
  await expect(page.getByTestId("language").getByRole("button")).toHaveText(/fr/i);
});

test("link previews get the page they asked for", async ({ request }) => {
  const slack = await request.get("/", { maxRedirects: 0, headers: { "user-agent": "Slackbot-LinkExpanding 1.0", "accept-language": "fr-FR,fr;q=0.9", cookie: `${LANG_COOKIE}=fr` } });
  expect(slack.status()).toBe(200);
  expect(await slack.text()).toContain('lang="en"');
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
