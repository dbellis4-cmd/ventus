import { test, expect } from "@playwright/test";

test("recurrence form exposes supported rules and returns keyboard focus on close", async ({ page }) => {
  await fetch("http://127.0.0.1:3174/__reset");
  await page.goto("/login");
  await page.getByLabel("Email").fill("fixture@ventus.test");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.goto("/?date=2026-10-22");
  const add = page.getByRole("button", { name: "Add task", exact: true });
  await add.click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.locator("details").filter({ hasText: "Recurrence" }).locator("summary").click();
  await dialog.getByRole("combobox", { name: "Repeat" }).selectOption("weekdays");
  await dialog.getByRole("checkbox", { name: "Mon" }).check();
  await dialog.getByRole("checkbox", { name: "Wed" }).check();
  await expect(dialog.getByLabel("End date (optional)")).toBeVisible();
  await expect(dialog.getByText("Missing local times and invalid month dates are skipped.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
});
