import { expect, test } from "@playwright/test";

test("chromium launches, renders a page, and runs JavaScript", async ({ page }) => {
  await page.setContent("<h1 id=t>harness ok</h1>");
  await expect(page.locator("#t")).toHaveText("harness ok");
  expect(await page.evaluate(() => 6 * 7)).toBe(42);
});

test("page.clock can pin the browser clock", async ({ page }) => {
  // The whole E2E strategy for streaks depends on this working.
  await page.clock.install({ time: new Date("2026-03-15T09:00:00") });
  await page.setContent("<span id=d></span>");
  await page.evaluate(() => {
    document.getElementById("d")!.textContent = new Date().toISOString().slice(0, 10);
  });
  await expect(page.locator("#d")).toHaveText("2026-03-15");
});
