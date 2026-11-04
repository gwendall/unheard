import { expect, test, type Page } from "@playwright/test";

// /example: no file to drop, the same page, the same search on the same archive, the same rule. What
// is simulated says so from the first moment to the last, and most real files do not end like this.

const NOTE = `Simulated: real planes, made-up sound. Most real clips get "Can't tell".`;
const STAY = ["where-name", "example-chip", "example-note", "answer-why"];
const rectsOf = (page: Page) =>
  page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().toJSON()])), STAY);

for (const [width, height] of [[1440, 900], [390, 844]]) {
  test(`from the home to a named place with nothing to drop, and nothing moving, at ${width} px`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const way = page.getByTestId("see-example");
    await expect(way).toBeVisible();
    await way.click();
    await expect(page).toHaveURL(/\/example$/);

    await expect(page.getByTestId("example-chip")).toHaveText("Simulated example");
    await expect(page.getByTestId("example-note")).toHaveText(NOTE);
    await expect(page.getByTestId("example-progress")).toBeVisible();
    await expect(page.getByTestId("where-day")).toHaveCount(0);
    const first = await rectsOf(page);

    await expect(page.getByTestId("where-verdict")).toHaveText(/^Probably filmed near /, { timeout: 200_000 });
    await expect(page.getByTestId("answer-when")).toHaveText(/^May 16, 2026, around /);
    await expect(page.getByTestId("answer-plane").nth(2)).toBeVisible();
    await expect(page.getByTestId("place-map")).toBeVisible();
    expect(await rectsOf(page)).toEqual(first);

    // Still said, and nothing that could pass it off as a real answer.
    await expect(page.getByTestId("example-chip")).toBeVisible();
    await expect(page.getByTestId("example-note")).toHaveText(NOTE);
    await expect(page.getByTestId("where-share")).toHaveCount(0);
    await expect(page.getByTestId("check-clean")).toHaveCount(0);
  });
}

test("a visitor's own file takes over, and is an ordinary file", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/example");
  await expect(page.getByTestId("where-verdict")).toBeVisible({ timeout: 200_000 });
  await expect(page.getByText("Try your own file")).toBeVisible();
  await page.getByTestId("answer-another").setInputFiles({ name: "mine.wav", mimeType: "audio/wav", buffer: Buffer.alloc(44) });
  await expect(page.getByTestId("where-name")).toHaveText("mine.wav");
  await expect(page.getByTestId("example-chip")).toHaveCount(0);
  await expect(page.getByTestId("example-note")).toHaveCount(0);
});

test("in French, at /fr/example", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/fr/example");
  await expect(page.getByTestId("example-chip")).toHaveText("Exemple simulé");
  await expect(page.getByTestId("example-note")).toContainText("Impossible de dire");
  await expect(page.getByTestId("where-verdict")).toHaveText(/^Probablement filmé près de /, { timeout: 200_000 });
});

test("the page with no file still says how it works, and folds it once there is an answer", async ({ page }) => {
  await page.goto("/where");
  await expect(page.getByTestId("where-scope")).toBeVisible();
  await expect(page.getByTestId("where-how")).toHaveCount(0);
});
