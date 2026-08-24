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
  const initialUpdates = page.getByRole("button", { name: /Updates available/ });
  await expect(initialUpdates).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: /External Browser Topic/ })).toHaveCount(0);
  await initialUpdates.hover();
  await expect(page.getByText("External Browser Topic", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh without moving" }).evaluate((button) => button.click());
  await expect(page.getByRole("button", { name: /External Browser Topic/ })).toBeVisible({ timeout: 5_000 });

  await page.getByRole("button", { name: "Open Browser Fixture" }).click();

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
  const resultTag = page.locator(".result-card").filter({ hasText: "Browser Fixture" }).getByLabel("Show topics tagged ui");
  const resultTagBox = await resultTag.boundingBox();
  expect(resultTagBox.height).toBeLessThan(32);
  await page.getByRole("button", { name: "Open Browser Fixture" }).click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially("\n\nLive before save.\n\nSaved through Playwright.");
  await expect(page.locator(".preview-scroll").getByText("Live before save.", { exact: true })).toBeVisible();
  await page.getByLabel("Change description").fill("Saved through the browser test.");
  await page.getByRole("button", { name: "Save safely" }).click();
  await expect(page.getByRole("article").getByText("Saved through Playwright.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Saved with conflict protection/)).toBeVisible();

  await page.getByRole("tab", { name: "Change history" }).click();
  await expect(page.getByText("Saved through the browser test.")).toBeVisible();
  await page.getByRole("button", { name: /Show all history/ }).click();
  const historyDialog = page.getByRole("dialog", { name: "History for browser-fixture" });
  await expect(historyDialog.getByText("Saved through the browser test.")).toBeVisible();
  await expect(historyDialog.getByText(/durable audit metadata/i)).toBeVisible();
  await historyDialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("tab", { name: /Files/ }).click();

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
  const updates = page.getByRole("button", { name: /Updates available/ });
  await expect(updates).toBeVisible({ timeout: 5_000 });
  await updates.hover();
  await expect(page.getByText("Browser Fixture", { exact: true }).last()).toBeVisible();
  const scrollBeforeRefresh = await page.evaluate(() => {
    window.scrollTo(0, Math.min(220, document.documentElement.scrollHeight - window.innerHeight));
    return window.scrollY;
  });
  await page.getByRole("button", { name: "Refresh without moving" }).evaluate((button) => button.click());
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollBeforeRefresh);
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
  const activeWorkspace = page.locator(".workspace-slot:not([hidden])");
  await expect(activeWorkspace.locator(".file-list").getByRole("button", { name: /observations\.md/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /observations\.md/ })).toBeVisible();
  const fileTimestamp = page.locator(".workspace-slot:not([hidden]) .file-label small").first();
  await expect(fileTimestamp.getByText(/Updated August/)).toBeVisible();
  await expect(fileTimestamp.getByText(/^at \d{1,2}:\d{2} [AP]M$/)).toBeVisible();
  expect(await fileTimestamp.evaluate((element) => ({ children: element.childElementCount, clipped: element.scrollWidth > element.clientWidth }))).toEqual({ children: 2, clipped: false });
  const browserGroup = page.locator(".tab-group").filter({ has: page.locator(".tab-group-label", { hasText: "Browser Fixture" }) });
  const browserGroupLabel = browserGroup.locator(".tab-group-label");
  await expect(browserGroup).toHaveAttribute("data-group-tone", /[0-7]/);
  await expect(browserGroupLabel).toHaveAttribute("aria-expanded", "true");
  const groupedTabs = browserGroup.locator(".document-tab");
  await groupedTabs.first().dragTo(groupedTabs.last());
  await expect(browserGroup.getByRole("tab").first()).toHaveAccessibleName(/observations\.md/);
  await browserGroupLabel.click();
  await expect(browserGroup.getByRole("tab")).toHaveCount(0);
  await browserGroupLabel.click();
  await expect(browserGroup.getByRole("tab")).toHaveCount(2);
  await activeWorkspace.getByLabel("Sort topic files").selectOption("name");
  await activeWorkspace.getByRole("button", { name: "Show all 2 files" }).click();
  const fileBrowser = page.getByRole("dialog", { name: "All files in Browser Fixture" });
  await expect(fileBrowser.getByText("observations.md", { exact: true })).toBeVisible();
  const rootFolder = fileBrowser.getByRole("button", { name: /Topic root/ });
  await expect(rootFolder).toHaveAttribute("aria-expanded", "true");
  await rootFolder.click();
  await expect(rootFolder).toHaveAttribute("aria-expanded", "false");
  await fileBrowser.getByRole("button", { name: "List" }).click();
  await expect(fileBrowser.getByText("observations.md", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(fileBrowser).toHaveCount(0);

  await activeWorkspace.getByRole("button", { name: "Inspect topic catalogue" }).click();
  await expect(page.getByRole("dialog", { name: "browser-fixture topic catalogue" })).toBeVisible();
  await expect(page.getByText("Schema version")).toBeVisible();
  const topicCatalogueDialog = page.getByRole("dialog", { name: "browser-fixture topic catalogue" });
  expect(await topicCatalogueDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole("tab", { name: "Raw JSON" }).click();
  await expect(page.locator(".raw-catalogue")).toContainText('"topic"');
  expect(await topicCatalogueDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const observationEditor = page.locator(".workspace-slot:not([hidden]) .cm-content");
  await observationEditor.press("ControlOrMeta+End");
  await observationEditor.pressSequentially("\n\nDraft isolated in observations.");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Discard the unsaved draft");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Close Browser Fixture observations.md" }).click();
  await expect(page.getByRole("tab", { name: /observations\.md/ })).toBeVisible();
  await page.getByRole("tab", { name: /context\.md/ }).click();
  await expect(page.getByRole("heading", { name: "Safe reading" })).toBeVisible();
  await page.getByRole("tab", { name: /observations\.md/ }).click();
  await expect(page.locator(".preview-scroll").getByText("Draft isolated in observations.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: /Topics$/ }).click();
  await page.getByRole("button", { name: "Open External Browser Topic" }).click();
  await expect(page.getByRole("tab", { name: /External Browser Topic.*context\.md/ })).toBeVisible();

  await page.getByRole("button", { name: /Tags/ }).click();
  await expect(page.getByRole("heading", { name: "Tags" })).toBeVisible();
  await expect(page.getByRole("button", { name: "#live-refresh", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /History/ }).click();
  const historyView = page.locator("main.surface");
  await expect(historyView.getByText("Saved through the browser test.")).toBeVisible();
  await historyView.getByRole("button", { name: /Saved through the browser test/ }).click();
  await expect(page.getByRole("heading", { name: "Safe reading" })).toBeVisible();

  await page.getByRole("button", { name: "System" }).click();
  await page.getByRole("button", { name: "Inspect root catalogue" }).click();
  await expect(page.getByRole("dialog", { name: "Root catalogue" })).toBeVisible();
  await expect(page.getByText("Documents", { exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Raw JSON" }).click();
  await expect(page.locator(".raw-catalogue")).toContainText('"topics"');
  await page.getByRole("button", { name: "Close", exact: true }).click();

  const openTabs = await page.getByRole("tab").count();
  expect(openTabs).toBeGreaterThanOrEqual(3);
  await page.reload();
  await expect(page.getByRole("tab", { name: /observations\.md/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /External Browser Topic.*context\.md/ })).toBeVisible();
});
