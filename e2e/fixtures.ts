import { test as base, expect } from "@playwright/test";

// Every date-dependent assertion in this app — streaks, achievement rates, the
// heatmap — is a function of "what day is it". Left to the real clock, a spec
// asserting "5 day streak" breaks the moment a run crosses midnight, and the
// failure looks like a product bug. So the clock is pinned for every spec.
//
// The app takes "today" from the browser (see docs/design.md), which is exactly
// what makes pinning it here sufficient.
export const FIXED_NOW = new Date("2026-03-15T09:00:00");
export const TODAY = "2026-03-15";

/** `YYYY-MM-DD` for n days before TODAY. Pure string/UTC math — no TZ involved. */
export function daysAgo(n: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export const test = base.extend({
  page: async ({ page }, use) => {
    // Must be installed before the first navigation, or the app reads the real clock.
    await page.clock.install({ time: FIXED_NOW });
    await use(page);
  },
});

export { expect };

// Phase 2 adds authentication. Extend this file with a logged-in fixture then —
// specs should not each re-implement the login flow.
