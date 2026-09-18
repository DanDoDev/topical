import { expect, test } from "@playwright/test";

test("create on-call work, draft a document, and complete a global follow-up", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New topic", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create topic" });
  await create.getByLabel("Title", { exact: true }).fill("Orbit Rotation");
  await create.getByLabel("Starting structure").selectOption("oncall");
  await create.getByLabel("Summary").fill("Keep active issues and handoffs organized.");
  await create.getByLabel("Change description").fill("Started the Orbit rotation.");
  await create.getByRole("button", { name: "Create topic", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Active work", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New issue, plan, or draft" }).click();
  const work = page.getByRole("dialog", { name: "Create linked work" });
  await work.getByLabel("Title", { exact: true }).fill("API timeouts");
  await work.getByLabel("Folder or document name").fill("inc-042");
  await work.getByLabel("Brief", { exact: true }).fill("Observed intermittent timeouts.\n\n- [ ] Confirm affected regions");
  await work.getByLabel("Change description").fill("Tracked the API timeout issue.");
  await work.getByRole("button", { name: "Review parent context" }).click();
  await work.getByRole("button", { name: "Create and link work" }).click();
  await expect(page.getByRole("heading", { name: "API timeouts", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New issue, plan, or draft" }).click();
  await work.getByLabel("Work type").selectOption("draft");
  await work.getByLabel("Title", { exact: true }).fill("Recovery runbook");
  await work.getByLabel("Folder or document name").fill("recovery");
  await work.getByLabel("Brief", { exact: true }).fill("- [ ] Restart the fictional service");
  await work.getByLabel("Change description").fill("Drafted a recovery runbook.");
  await work.getByRole("button", { name: "Review parent context" }).click();
  await work.getByRole("button", { name: "Create and link work" }).click();
  await expect(page.getByRole("heading", { name: "Recovery runbook", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("combobox", { name: "Topic", exact: true }).selectOption("orbit-rotation");
  await expect(page.getByRole("checkbox", { name: "Complete: Confirm affected regions" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Tasks", exact: true }).getByText("Restart the fictional service", { exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Complete: Confirm affected regions" }).click();
  await expect(page.getByText("No open tasks in this scope.")).toBeVisible();
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("completed");
  await expect(page.getByRole("checkbox", { name: "Reopen: Confirm affected regions" })).toBeChecked();
  await page.screenshot({ path: "test-results/workflow-tasks.png", fullPage: true });
  await page.getByRole("button", { name: "Open source", exact: true }).click();
  await expect(page.getByRole("heading", { name: "API timeouts", exact: true })).toBeVisible();
  await expect(page.getByRole("article").getByRole("checkbox")).toBeChecked();
  await page.getByRole("article").getByRole("link", { name: "Recovery runbook" }).click();
  await expect(page.getByRole("heading", { name: "Recovery runbook", exact: true })).toBeVisible();
});
