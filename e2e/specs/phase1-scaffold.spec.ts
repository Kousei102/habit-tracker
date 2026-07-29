import { expect, expectDashboardReady, open, test } from "../fixtures.ts";

// Phase 1 acceptance criteria, as they stand after Phase 7.
//
// AC-1.2 – AC-1.6 were retired with the server and SQLite (docs/phases.md, the
// ⚠ section). AC-1.7 said the client must render the result of `GET /api/health`;
// there is no such route any more, and AC-7.3 now forbids the request outright,
// so that half of the criterion is superseded rather than failed. What survives —
// and is still worth a spec — is the half that was never about the server:
//
//   AC-1.7 (residual) Opening `/` in a browser shows the page.
//   AC-1.8            `npx tsc --noEmit` passes. Checked by the harness, not here.

test.describe("Phase 1 — the app loads", () => {
  test("AC-1.7 (residual): opening / renders the app", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await open(page);

    await expect(page.getByRole("heading", { level: 1, name: "習慣トラッカー" })).toBeVisible();
    await expectDashboardReady(page);

    // A blank page with a broken bundle would still have a <title>; an uncaught
    // exception is what that failure actually looks like.
    expect(pageErrors, "the page threw while loading").toEqual([]);
  });

  test("the built bundle is loaded from the same origin as the document", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-type"] ?? "").toMatch(/text\/html/);

    const origin = new URL(page.url()).origin;
    const scripts = await page
      .locator("script[src]")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLScriptElement).src));

    expect(scripts.length, "the page loads a built bundle").toBeGreaterThan(0);
    for (const src of scripts) expect(new URL(src).origin).toBe(origin);
    // A production build must not need a dev server's client.
    expect(scripts.join(" ")).not.toContain("/@vite/");
  });
});
