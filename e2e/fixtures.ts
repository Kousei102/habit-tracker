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

/**
 * The today panel once its fetch has answered, whichever way it went: the list,
 * the "no habits yet" line, or the failure message.
 *
 * Deliberately a *positive* locator. Waiting for the loading placeholder to
 * disappear would be satisfied by a page that has not rendered anything yet.
 */
const todayPanelSettled = (page: Page) =>
  page
    .getByRole("list", { name: "習慣一覧" })
    .or(page.getByText("習慣がまだ登録されていません。"))
    .or(page.getByText("習慣を読み込めませんでした"));

/** The statistics panel, same three outcomes. */
const statsPanelSettled = (page: Page) =>
  page
    .getByRole("list", { name: "習慣の統計" })
    .or(page.getByText("習慣を登録すると"))
    .or(page.getByText("統計を読み込めませんでした"));

/**
 * Waits until the dashboard has finished its initial loads.
 *
 * The heading renders immediately, but the habit list only exists once
 * `GET /api/habits` has answered (`TodayPanel` renders the `<ul>` under
 * `status === "ready" && habits.length > 0`). Anything that reads the list
 * without retrying — `locator.count()` — sees 0 in that gap, and any assertion
 * about *absence* passes vacuously in it.
 *
 * Call this after a navigation whenever the next step counts rows or asserts
 * that something is not there. `loginAs` already calls it.
 */
export async function expectDashboardReady(page: Page): Promise<void> {
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(todayPanelSettled(page)).toBeVisible();
  await expect(statsPanelSettled(page)).toBeVisible();
}

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
 * Opens `/` and signs in, leaving the page on a dashboard whose panels have
 * finished loading.
 *
 * Phase 3 onwards should call this (or use the `loggedInPage` fixture) rather
 * than re-implementing the flow: when the login screen changes, it changes here
 * once.
 *
 * Waiting only for the heading — as this used to — hands the spec a page whose
 * habit list has not been fetched yet. That is not a slow machine's problem: the
 * heading and the list come from two different responses, so the gap is always
 * there and only its width varies.
 */
export async function loginAs(page: Page, credentials: Credentials = CREDENTIALS): Promise<void> {
  await page.goto("/");
  await expect(loginHeading(page)).toBeVisible();
  await submitLogin(page, credentials);
  await expectDashboardReady(page);
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
