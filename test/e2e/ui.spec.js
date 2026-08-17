import { expect, test } from "@playwright/test";

test("browse, search, edit, and audit through the loopback UI", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Topics" })).toBeVisible();
  const searchContrast = await page.getByLabel("Search Topical").evaluate((input) => {
    const luminance = (value) => {
      const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const background = luminance(getComputedStyle(input).backgroundColor);
    const text = luminance(getComputedStyle(input).color);
    const placeholder = luminance(getComputedStyle(input, "::placeholder").color);
    const ratio = (left, right) => (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
    return { text: ratio(text, background), placeholder: ratio(placeholder, background) };
  });
  expect(searchContrast.text).toBeGreaterThanOrEqual(4.5);
  expect(searchContrast.placeholder).toBeGreaterThanOrEqual(4.5);

  const bootstrap = await page.evaluate(() => fetch("/api/v1/bootstrap").then((response) => response.json()));
  await page.evaluate(async (csrfToken) => {
    const response = await fetch("/api/v1/test-external-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Topical-CSRF": csrfToken },
      body: "{}"
    });
    if (!response.ok) throw new Error(`External fixture failed: ${response.status}`);
  }, bootstrap.csrfToken);
  await expect(page.getByRole("button", { name: /External Browser Topic/ })).toBeVisible({ timeout: 5_000 });

  await page.getByRole("button", { name: /Browser Fixture/ }).click();

  await expect(page.getByRole("heading", { name: "Safe reading" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Topic sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Hide topic sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Topic sidebar" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show topic sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Topic sidebar" })).toBeVisible();
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
  await editor.pressSequentially("\n\nLive before save.\n\nSaved through Playwright.");
  await expect(page.locator(".preview-scroll").getByText("Live before save.", { exact: true })).toBeVisible();
  await page.getByLabel("Change description").fill("Saved through the browser test.");
  await page.getByRole("button", { name: "Save safely" }).click();
  await expect(page.getByRole("article").getByText("Saved through Playwright.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Saved with conflict protection/)).toBeVisible();

  await expect(page.getByText("Topic history")).toBeVisible();
  await expect(page.getByText("Saved through the browser test.")).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially("\n\nUnsaved browser draft.");
  await page.evaluate(async (csrfToken) => {
    const response = await fetch("/api/v1/test-external-file", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Topical-CSRF": csrfToken },
      body: "{}"
    });
    if (!response.ok) throw new Error(`External file fixture failed: ${response.status}`);
  }, bootstrap.csrfToken);
  await expect(page.getByRole("dialog", { name: "This file changed elsewhere" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("dialog").getByText("Unsaved browser draft.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Keep draft after review" }).click();
  await expect(page.locator(".preview-scroll").getByText("Unsaved browser draft.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Create supporting file" }).click();
  await page.getByLabel("File name").fill("observations.MD");
  await expect(page.getByText("observations.md", { exact: true })).toBeVisible();
  await page.getByLabel("Change description").fill("Added a generated Markdown note.");
  await page.getByRole("button", { name: "Create file" }).click();
  await expect(page.getByRole("button", { name: /observations\.md/ })).toBeVisible();

  await page.getByRole("button", { name: /Tags/ }).click();
  await expect(page.getByRole("heading", { name: "Tags" })).toBeVisible();
  await expect(page.getByText("#live-refresh")).toBeVisible();

  await page.getByRole("button", { name: /History/ }).click();
  await expect(page.getByText("Saved through the browser test.")).toBeVisible();
});
