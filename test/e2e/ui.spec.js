import { expect, test } from "@playwright/test";

test("browse, search, edit, and audit through the loopback UI", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Topics" })).toBeVisible();
  await page.getByRole("button", { name: /Browser Fixture/ }).click();

  await expect(page.getByRole("heading", { name: "Safe reading" })).toBeVisible();
  await expect(page.getByText(/title: "Browser Fixture"/)).toHaveCount(0);
  await expect(page.locator("script").filter({ hasText: "window.__unsafe" })).toHaveCount(0);

  await page.getByRole("button", { name: /Search/ }).first().click();
  await page.getByPlaceholder("Search titles, tags, headings, and Markdown…").fill("recherche multilingue");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("strict", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Browser Fixture/ }).click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially("\n\nSaved through Playwright.");
  await page.getByLabel("Change description").fill("Saved through the browser test.");
  await page.getByRole("button", { name: "Save safely" }).click();
  await expect(page.getByRole("article").getByText("Saved through Playwright.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Saved with conflict protection/)).toBeVisible();

  await page.getByRole("button", { name: /History/ }).click();
  await expect(page.getByText("Saved through the browser test.")).toBeVisible();
});
