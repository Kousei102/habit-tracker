import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Every date-dependent assertion in this app — streaks, achievement rates, the
// heatmap — is a function of "what day is it". Left to the real clock, a spec
// asserting "5 day streak" breaks the moment a run crosses midnight, and the
// failure looks like a product bug. So the clock is pinned for every spec, and
// every seeded day below is expressed as an offset from the pinned day.
//
// The app takes "today" from the browser (docs/design.md §1), which is exactly
// what makes pinning it here sufficient.
export const FIXED_NOW = new Date("2026-03-15T09:00:00");
export const TODAY = "2026-03-15";

/** `YYYY-MM-DD` for n days before TODAY. Pure UTC math — no local TZ involved. */
export function daysAgo(n: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The saved document.
//
// Phase 7 moved the data into the browser, so the way a spec sets up history is
// to put a document in `localStorage` rather than to POST to an API. The key and
// the shape below are the *contract* being tested: they are written out here by
// hand rather than imported from client/src/data/document.ts, so a spec cannot
// silently follow the implementation if it changes the format.
// ---------------------------------------------------------------------------

export const STORAGE_KEY = "habit-tracker";
export const SCHEMA_VERSION = 1;

export type SeedHabit = {
  id: number;
  name: string;
  kind: "boolean" | "numeric";
  target?: number | null;
  unit?: string | null;
  color?: string;
  sort_order?: number;
  archived_at?: string | null;
  created_at?: string;
};

/** `habit id → YYYY-MM-DD → value`, exactly as the app stores it. */
export type SeedEntries = Record<number, Record<string, number>>;

export type SeedInput = {
  habits?: SeedHabit[];
  entries?: SeedEntries;
  /** Overridable so a spec can plant a document from a *newer* build. */
  version?: number;
  next_habit_id?: number;
};

/** The document as a JSON string, with the fields a spec did not care about filled in. */
export function documentText(input: SeedInput = {}): string {
  const habits = (input.habits ?? []).map((habit, index) => ({
    id: habit.id,
    name: habit.name,
    kind: habit.kind,
    target: habit.target ?? null,
    unit: habit.unit ?? null,
    color: habit.color ?? "blue",
    sort_order: habit.sort_order ?? index,
    archived_at: habit.archived_at ?? null,
    created_at: habit.created_at ?? "2026-01-01T00:00:00.000Z",
  }));

  const maxId = habits.reduce((max, habit) => Math.max(max, habit.id), 0);

  const entries: Record<string, Record<string, number>> = {};
  for (const [habitId, days] of Object.entries(input.entries ?? {})) entries[habitId] = { ...days };

  return JSON.stringify({
    version: input.version ?? SCHEMA_VERSION,
    next_habit_id: input.next_habit_id ?? maxId + 1,
    habits,
    entries,
  });
}

/** `{ 0: 1, 2: 1 }` (days before TODAY) → `{ "2026-03-15": 1, "2026-03-13": 1 }`. */
export function byDaysAgo(offsets: Record<number, number>): Record<string, number> {
  const days: Record<string, number> = {};
  for (const [offset, value] of Object.entries(offsets)) days[daysAgo(Number(offset))] = value;
  return days;
}

/** Days `from`…`to` before today, all with the same value. Offsets, not dates. */
export function run(from: number, to: number, value = 1): Record<number, number> {
  const days: Record<number, number> = {};
  for (let n = from; n <= to; n += 1) days[n] = value;
  return days;
}

// ---------------------------------------------------------------------------
// Getting a seeded document in front of the app.
//
// Load, write the key, reload. Deliberately *not* `addInitScript`, which re-runs
// on every navigation and would therefore overwrite whatever the user just saved
// — which is precisely what half of these specs reload in order to check.
// ---------------------------------------------------------------------------

/** Writes the exact bytes given, then reloads so the app reads them fresh. */
export async function seedRaw(page: Page, text: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [STORAGE_KEY, text],
  );
  await page.reload();
}

/** Opens the app with the given document (or with nothing stored at all). */
export async function open(page: Page, input?: SeedInput): Promise<void> {
  if (input === undefined) {
    await page.goto("/");
    return;
  }
  await seedRaw(page, documentText(input));
}

/** Opens the app with the given document and waits for the panels to settle. */
export async function openDashboard(page: Page, input?: SeedInput): Promise<void> {
  await open(page, input);
  await expectDashboardReady(page);
}

/** The stored bytes, exactly as they are — `null` when the key is absent. */
export async function readStorage(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Locators shared across phases.
//
// Everything below is addressed the way a user (or a screen reader) reaches it:
// by role and accessible name. No CSS classes, no DOM shape — a spec that breaks
// on a correct refactor is not testing the acceptance criteria.
// ---------------------------------------------------------------------------

export const dashboardHeading = (page: Page) => page.getByRole("heading", { name: "ダッシュボード" });

export const habitList = (page: Page) => page.getByRole("list", { name: "習慣一覧" });
export const habitRow = (page: Page, name: string) =>
  habitList(page).getByRole("listitem").filter({ hasText: name });

export const statsList = (page: Page) => page.getByRole("list", { name: "習慣の統計" });
export const statsRow = (page: Page, name: string) =>
  statsList(page).getByRole("listitem").filter({ hasText: name });

export const nameField = (page: Page) => page.getByLabel("習慣名");
export const targetField = (page: Page) => page.getByLabel("目標値");
export const unitField = (page: Page) => page.getByLabel("単位");
export const kindOption = (page: Page, label: "チェック式" | "数値式") =>
  page.getByRole("radio", { name: label });
export const addButton = (page: Page) => page.getByRole("button", { name: "追加" });
export const saveButton = (page: Page) => page.getByRole("button", { name: "保存" });

export const checkbox = (page: Page, name: string) => page.getByRole("checkbox", { name });
export const amountField = (page: Page, name: string) => page.getByRole("spinbutton", { name });
export const editButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} を編集` });
export const deleteButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} を削除` });
export const undoButton = (page: Page) => page.getByRole("button", { name: "削除を取り消す" });

export const heatmapGrid = (page: Page) => page.getByRole("grid", { name: /年間ヒートマップ/ });
export const heatmapPicker = (page: Page) => page.getByLabel("表示する習慣");
export const cellFor = (page: Page, date: string) => page.getByRole("gridcell", { name: date });

/** The error messages on screen, addressed by role and narrowed to their words. */
export const alertWith = (page: Page, text: string | RegExp) =>
  page.getByRole("alert").filter({ hasText: text });

/**
 * The today panel once it has decided what to draw, whichever way it went: the
 * list, the "no habits yet" line, or the failure message.
 *
 * Deliberately a *positive* locator. Waiting for the loading placeholder to
 * disappear would be satisfied by a page that has not rendered anything yet.
 */
const todayPanelSettled = (page: Page) =>
  habitList(page)
    .or(page.getByText("習慣がまだ登録されていません。"))
    .or(page.getByText("習慣を読み込めませんでした"));

/** The statistics panel, same three outcomes. */
const statsPanelSettled = (page: Page) =>
  statsList(page)
    .or(page.getByText("習慣を登録すると"))
    .or(page.getByText("統計を読み込めませんでした"));

/**
 * Waits until the dashboard has finished its initial render.
 *
 * Call this after a navigation whenever the next step counts rows or asserts
 * that something is not there: `locator.count()` does not retry, so it reads 0
 * in the gap before the panels exist and any assertion about *absence* passes
 * vacuously there.
 */
export async function expectDashboardReady(page: Page): Promise<void> {
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(todayPanelSettled(page)).toBeVisible();
  await expect(statsPanelSettled(page)).toBeVisible();
}

/** Waits until the heatmap panel has drawn its grid. */
export async function expectHeatmapReady(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "年間ヒートマップ" })).toBeVisible();
  await expect(heatmapGrid(page)).toBeVisible();
}

export const test = base.extend({
  page: async ({ page }, use) => {
    // Must be installed before the first navigation, or the app reads the real clock.
    await page.clock.install({ time: FIXED_NOW });
    await use(page);
  },
});

export { expect };
