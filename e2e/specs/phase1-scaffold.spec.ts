import { expect, test } from "../fixtures.ts";

// Phase 1 acceptance criteria under test here:
//
//   AC-1.7 [E2E] Opening `/` in a browser shows a page, and the result the client
//                fetched from `/api/health` is rendered on screen.
//
// AC-1.3 (`GET /api/health` -> 200 `{"ok":true}`) is additionally pinned from the
// browser's own request context, because AC-1.7 is only meaningful if what the
// page renders came from that response.
//
// Written against the AC, not against the markup: the health readout is located
// by its `status` role (the accessible way to expose an async result) and by the
// text a user reads, never by CSS classes or DOM shape.

const HEALTH_PATH = "/api/health";

/** The user-visible health readout. `role=status` is how an async result is exposed to AT. */
function healthReadout(page: import("@playwright/test").Page) {
  return page.getByRole("status");
}

test.describe("Phase 1 — scaffold", () => {
  test("AC-1.3: GET /api/health answers 200 with {\"ok\":true}", async ({ request }) => {
    const response = await request.get(HEALTH_PATH);

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"] ?? "").toMatch(/application\/json/);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("AC-1.7: opening / renders a page", async ({ page }) => {
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);

    // A page, not a blank shell: a level-1 heading is visible and the document has a title.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(/.+/);
  });

  test("AC-1.7: the client fetches /api/health and renders the result", async ({ page }) => {
    const healthResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === HEALTH_PATH && r.request().method() === "GET",
    );

    await page.goto("/");

    // The page must actually ask the API — a hardcoded "ok" on screen is not AC-1.7.
    const response = await healthResponse;
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    // ...and the answer must reach the screen.
    const readout = healthReadout(page);
    await expect(readout).toBeVisible();
    await expect(readout).toHaveText(/ok/i);
    // Still showing a placeholder means the result was never rendered.
    await expect(readout).not.toHaveText(/確認中|loading/i);
    await expect(page.getByText(/{\s*"?ok"?\s*:\s*true\s*}/)).toBeVisible();
  });

  test("AC-1.7: what is rendered is derived from the response, not hardcoded", async ({ page }) => {
    // If the API is unhealthy, the page must not keep claiming a healthy API.
    // (How the failure is worded is Phase 6's concern; here it only must not lie.)
    await page.route(HEALTH_PATH, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }),
    );

    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/{\s*"?ok"?\s*:\s*true\s*}/)).toHaveCount(0);
    // Assert the readout exists before asserting what it does *not* say, so the
    // negative check below cannot pass vacuously on a missing element.
    await expect(healthReadout(page)).toBeVisible();
    await expect(healthReadout(page)).not.toHaveText(/(^|[^n])ok\s*$/i);
  });

  test("AC-1.7: the rendered result survives a reload", async ({ page }) => {
    await page.goto("/");
    await expect(healthReadout(page)).toHaveText(/ok/i);

    await page.reload();
    await expect(healthReadout(page)).toHaveText(/ok/i);
  });
});
