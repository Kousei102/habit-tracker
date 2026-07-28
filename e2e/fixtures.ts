import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_USER } from "./playwright.config.ts";

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

/**
 * The credentials global-setup seeds into the E2E database. Re-exported here so
 * specs have a single import for everything they need to sign in.
 */
export const CREDENTIALS = { username: E2E_USER, password: E2E_PASSWORD } as const;

/** Name of the session cookie, as observed on the wire (not imported from server code). */
export const SESSION_COOKIE = "session";

// ---------------------------------------------------------------------------
// Locators shared across phases.
//
// Everything below is addressed the way a user (or a screen reader) reaches it:
// by role and accessible name. No CSS classes, no DOM shape — a spec that breaks
// on a correct refactor is not testing the acceptance criteria.
// ---------------------------------------------------------------------------

export const loginHeading = (page: Page) => page.getByRole("heading", { name: "ログイン" });
export const usernameField = (page: Page) => page.getByLabel("ユーザー名");
export const passwordField = (page: Page) => page.getByLabel("パスワード");
export const loginButton = (page: Page) => page.getByRole("button", { name: "ログイン" });
export const loginError = (page: Page) => page.getByRole("alert");

export const dashboardHeading = (page: Page) => page.getByRole("heading", { name: "ダッシュボード" });
export const logoutButton = (page: Page) => page.getByRole("button", { name: "ログアウト" });

export type Credentials = { username: string; password: string };

/**
 * Fills and submits the login form on the page as it currently stands.
 * Does not navigate and does not assert the outcome — failure paths need to
 * observe what happens next themselves.
 */
export async function submitLogin(page: Page, credentials: Credentials = CREDENTIALS): Promise<void> {
  await usernameField(page).fill(credentials.username);
  await passwordField(page).fill(credentials.password);
  await loginButton(page).click();
}

/**
 * Opens `/` and signs in, leaving the page on the dashboard.
 *
 * Phase 3 onwards should call this (or use the `loggedInPage` fixture) rather
 * than re-implementing the flow: when the login screen changes, it changes here
 * once.
 */
export async function loginAs(page: Page, credentials: Credentials = CREDENTIALS): Promise<void> {
  await page.goto("/");
  await expect(loginHeading(page)).toBeVisible();
  await submitLogin(page, credentials);
  await expect(dashboardHeading(page)).toBeVisible();
}

type Fixtures = {
  /** A page that is already signed in and sitting on the dashboard. */
  loggedInPage: Page;
};

export const test = base.extend<Fixtures>({
  page: async ({ page }, use) => {
    // Must be installed before the first navigation, or the app reads the real clock.
    await page.clock.install({ time: FIXED_NOW });
    await use(page);
  },

  loggedInPage: async ({ page }, use) => {
    await loginAs(page);
    await use(page);
  },
});

export { expect };
