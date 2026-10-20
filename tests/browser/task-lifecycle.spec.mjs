import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await fetch("http://127.0.0.1:3174/__reset");
  await page.goto("/login");
  await page.getByLabel("Email").fill("fixture@ventus.test");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.goto("/?date=2026-10-22");
  await expect(page.getByRole("button", { name: "Research Paper" })).toBeVisible();
});

test("subtask section opens with an editable row and persists the edit", async ({ page }) => {
  await page.getByRole("button", { name: "Research Paper" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit task" });
  const subtasks = dialog.locator("details").filter({ hasText: "Subtasks" });
  await subtasks.locator("summary").click();
  await subtasks.locator("summary").click();
  await expect(dialog.getByPlaceholder("Subtask title")).toHaveCount(1);
  await expect(dialog.getByPlaceholder("Subtask title")).toHaveValue("Active research");
  await expect(dialog.getByText("Canceled research")).toHaveCount(0);
  await dialog.getByPlaceholder("Subtask title").fill("Edited research");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Edited research" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Edited research" })).toBeVisible();
});

test("parent category changes update active children, preserve canceled history, and survive reload", async ({ page }) => {
  await page.getByRole("button", { name: "Research Paper" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit task" });
  await dialog.getByLabel("Category").selectOption({ label: "Meetings" });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Task saved." }).first()).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Research Paper" }).click();
  await expect(page.getByRole("dialog", { name: "Edit task" }).getByLabel("Category")).toHaveValue("00000000-0000-4000-8000-000000000091");
  const state = await (await fetch("http://127.0.0.1:3174/__state")).json();
  assertCategory(state.tasks, 1, 91);
  assertCategory(state.tasks, 2, 91);
  assertCategory(state.tasks, 3, 90);
  expect(state.occurrences.find(item => item.task_id.endsWith("003")).status).toBe("canceled");
  expect(state.activity.some(item => item.task_id.endsWith("003"))).toBe(false);
});

test("parent deletion warning counts active and canceled descendants without deleting on Back", async ({ page }) => {
  await page.getByRole("button", { name: "Research Paper" }).click();
  await page.getByRole("dialog", { name: "Edit task" }).getByRole("button", { name: "Delete task & subtasks" }).click();
  const warning = page.getByRole("dialog", { name: "Delete task" });
  await expect(warning).toContainText("also deletes 2 subtasks (1 active, 1 already canceled)");
  await warning.getByRole("button", { name: "Back" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Research Paper" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Active research" })).toBeVisible();
});

function assertCategory(tasks, suffix, categorySuffix) {
  expect(tasks.find(item => item.id.endsWith(String(suffix).padStart(3, "0"))).category_id)
    .toBe(`00000000-0000-4000-8000-${String(categorySuffix).padStart(12, "0")}`);
}
