import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "@playwright/test";
import { daysAgo, expect, test } from "../fixtures.ts";
import { E2E_DB_PATH } from "../playwright.config.ts";

// Phase 4 acceptance criteria under test here:
//
//   AC-4.7 [E2E] Five achieved days including today reads 現在ストリーク 5.
//   AC-4.8 [E2E] Breaking one of those days shortens the current streak correctly.
//   AC-4.9 [E2E] The 30 day achievement rate shows the expected value.
//
// AC-4.2 ("today is not over, so an unachieved today must not reset the streak")
// is nominally a unit criterion, but it is the single rule this phase exists for
// and the one a plausible implementation gets wrong, so it is exercised through
// the real screen as well. Same for AC-4.6 (a numeric day below its target is not
// an achievement).
//
// The clock is pinned to 2026-03-15 by the shared fixture, and every seeded day
// below is expressed as an offset from it — nothing here reads a real calendar,
// so a run that crosses midnight cannot turn a pass into a failure.
//
// Negative controls are deliberate: streak numbers "look right" very easily. An
// implementation that simply counted entry rows, or that counted every recorded
// day regardless of value, would pass a happy-path assertion. Each test below
// therefore also seeds days that must NOT be counted.

// ---------------------------------------------------------------------------
// The database, read directly — only where an AC talks about something the
// screen cannot show (that a record really was written, and really was ignored).
// ---------------------------------------------------------------------------

const DB_FILE = path.resolve(import.meta.dirname, "../..", E2E_DB_PATH);

type EntryRow = { date: string; value: number };

function readEntries(habitId: number): EntryRow[] {
  const db = new DatabaseSync(DB_FILE);
  try {
    return db
      .prepare("SELECT date, value FROM entries WHERE habit_id = ? ORDER BY date")
      .all(habitId) as unknown as EntryRow[];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Screen vocabulary — role and accessible name only.
// ---------------------------------------------------------------------------

const statsHeading = (page: Page) => page.getByRole("heading", { name: "統計" });
const statsList = (page: Page) => page.getByRole("list", { name: "習慣の統計" });
const statsRow = (page: Page, name: string) => statsList(page).getByRole("listitem").filter({ hasText: name });

const habitList = (page: Page) => page.getByRole("list", { name: "習慣一覧" });
const habitRow = (page: Page, name: string) => habitList(page).getByRole("listitem").filter({ hasText: name });
const checkbox = (page: Page, name: string) => page.getByRole("checkbox", { name });

const nameField = (page: Page) => page.getByLabel("習慣名");
const kindOption = (page: Page, label: "チェック式" | "数値式") => page.getByRole("radio", { name: label });
const addButton = (page: Page) => page.getByRole("button", { name: "追加" });

/**
 * The three headline numbers, asserted as the words on screen.
 *
 * `achieved` is the numerator of the 30 day window; the percentage is derived
 * here rather than passed in, so a test cannot quietly disagree with itself.
 */
async function expectStats(
  row: Locator,
  expected: { current: number; longest: number; achieved: number },
): Promise<void> {
  const percent = Math.round((expected.achieved / 30) * 100);

  await expect(row).toContainText(`現在ストリーク ${expected.current} 日`);
  await expect(row).toContainText(`最長ストリーク ${expected.longest} 日`);
  await expect(row).toContainText(`直近 30 日の達成率 ${percent}%（${expected.achieved} / 30 日）`);
}

// ---------------------------------------------------------------------------
// Seeding. History cannot be entered through the UI (only today is editable),
// so past days go in over the API — the same endpoint the UI uses.
// ---------------------------------------------------------------------------

type HabitInput = { name: string; kind: "boolean" | "numeric"; target?: number; unit?: string };

async function createHabit(page: Page, input: HabitInput): Promise<number> {
  const response = await page.request.post("/api/habits", { data: input });
  expect(response.status(), `POST /api/habits ${input.name}: ${await response.text()}`).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

/** Writes one value per day, keyed by "days before the pinned today". */
async function seedDays(page: Page, habitId: number, byDaysAgo: Record<number, number>): Promise<void> {
  for (const [offset, value] of Object.entries(byDaysAgo)) {
    const date = daysAgo(Number(offset));
    const response = await page.request.put(`/api/entries/${habitId}/${date}`, { data: { value } });
    expect(response.status(), `PUT /api/entries/${habitId}/${date} = ${value}: ${await response.text()}`).toBe(200);
  }
}

/** Days `from`…`to` before today, all achieved with the same value. */
function run(from: number, to: number, value = 1): Record<number, number> {
  const days: Record<number, number> = {};
  for (let n = from; n <= to; n += 1) days[n] = value;
  return days;
}

test.describe("Phase 4 — streaks and achievement rate", () => {
  test("the panel exists, and a habit with no records reads zero rather than blank", async ({
    loggedInPage: page,
  }) => {
    const name = "統計A_記録なし";

    await expect(statsHeading(page)).toBeVisible();

    await nameField(page).fill(name);
    await kindOption(page, "チェック式").check();
    await addButton(page).click();
    await expect(habitRow(page, name)).toBeVisible();

    // A brand-new habit is the baseline every other assertion is measured
    // against: if this row already showed a streak, nothing below would mean
    // anything.
    const row = statsRow(page, name);
    await expect(row).toHaveCount(1);
    await expectStats(row, { current: 0, longest: 0, achieved: 0 });

    await page.reload();
    await expectStats(statsRow(page, name), { current: 0, longest: 0, achieved: 0 });
  });

  // AC-4.7
  test("AC-4.7: five achieved days including today read as a 5 day streak", async ({ loggedInPage: page }) => {
    const name = "統計B_連続5日";
    const id = await createHabit(page, { name, kind: "boolean" });

    await seedDays(page, id, run(0, 4));

    await page.reload();
    await expectStats(statsRow(page, name), { current: 5, longest: 5, achieved: 5 });
  });

  // AC-4.7, negative control.
  test("AC-4.7 control: unrelated older records do not inflate the current streak", async ({
    loggedInPage: page,
  }) => {
    const name = "統計C_飛び石";
    const id = await createHabit(page, { name, kind: "boolean" });

    // Five in a row ending today, plus two achieved days a week earlier and one
    // recorded-but-not-done day in between. Eight rows, seven of them achieved —
    // a "count the rows" or "count the achieved days" implementation would say 8
    // or 7 here, and only a real streak says 5.
    await seedDays(page, id, { ...run(0, 4), 6: 0, 10: 1, 11: 1 });

    await page.reload();
    const row = statsRow(page, name);
    await expectStats(row, { current: 5, longest: 5, achieved: 7 });
    await expect(row).not.toContainText("現在ストリーク 7 日");
    await expect(row).not.toContainText("現在ストリーク 8 日");
  });

  // AC-4.8
  test("AC-4.8: breaking one day in the middle shortens the current streak", async ({ loggedInPage: page }) => {
    const name = "統計D_途中で途切れる";
    const id = await createHabit(page, { name, kind: "boolean" });

    await seedDays(page, id, run(0, 4));
    await page.reload();
    await expectStats(statsRow(page, name), { current: 5, longest: 5, achieved: 5 });

    // Two days ago is undone: the run ending today is now today + yesterday, and
    // the best run left in the history is the two days before the break.
    await seedDays(page, id, { 2: 0 });

    await page.reload();
    await expectStats(statsRow(page, name), { current: 2, longest: 2, achieved: 4 });
  });

  // AC-4.8 through the UI, and AC-4.2 with it: the day being undone is today.
  test("AC-4.8/AC-4.2: unticking today leaves the streak at four, not zero", async ({ loggedInPage: page }) => {
    const name = "統計E_今日を外す";
    const id = await createHabit(page, { name, kind: "boolean" });

    await seedDays(page, id, run(0, 4));
    await page.reload();
    await expect(checkbox(page, name)).toBeChecked();
    await expectStats(statsRow(page, name), { current: 5, longest: 5, achieved: 5 });

    await checkbox(page, name).uncheck();

    // Today is not over. The four days up to yesterday still stand, so the
    // count drops by exactly one — it does not collapse to 0.
    await page.reload();
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 4 });
  });

  // AC-4.2 — the rule of this phase, seen from the screen.
  test("AC-4.2: with today never recorded, the streak counts back from yesterday", async ({
    loggedInPage: page,
  }) => {
    const name = "統計F_今日は未記録";
    const id = await createHabit(page, { name, kind: "boolean" });

    // Yesterday and the three days before it. Nothing at all for today.
    await seedDays(page, id, run(1, 4));

    await page.reload();
    const row = statsRow(page, name);
    await expect(checkbox(page, name)).not.toBeChecked();
    await expectStats(row, { current: 4, longest: 4, achieved: 4 });

    // An explicit "not done today" row must read the same as no row: it is still
    // only today, and today is not over.
    await seedDays(page, id, { 0: 0 });
    await page.reload();
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 4 });

    // ...but yesterday IS over. Undoing it really does break the run: today's
    // grace reaches back one day, not two.
    await seedDays(page, id, { 1: 0 });
    await page.reload();
    await expectStats(statsRow(page, name), { current: 0, longest: 3, achieved: 3 });
  });

  // AC-4.6 from the screen: the streak must use the same "done" rule the row
  // itself displays.
  test("AC-4.6: a numeric day below its target is not counted", async ({ loggedInPage: page }) => {
    const name = "統計G_数値目標30";
    const id = await createHabit(page, { name, kind: "numeric", target: 30, unit: "分" });

    // today 10 (short), yesterday 30 (exactly on target), 2 days ago 45 (over),
    // 3 days ago 29 (one short), 4 days ago 30.
    await seedDays(page, id, { 0: 10, 1: 30, 2: 45, 3: 29, 4: 30 });

    await page.reload();
    const row = statsRow(page, name);
    // Five recorded days, three of them achievements. Today fell short but is
    // not over, so the run is yesterday + the day before.
    await expectStats(row, { current: 2, longest: 2, achieved: 3 });
    await expect(row).not.toContainText("現在ストリーク 5 日");
    await expect(row).not.toContainText("直近 30 日の達成率 17%（5 / 30 日）");
    // The row on the today panel agrees with the statistic: both say not done.
    await expect(habitRow(page, name)).toContainText("10 / 30 分");

    // Raising the short day to exactly the target joins the two runs.
    await seedDays(page, id, { 3: 30 });
    await page.reload();
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 4 });
  });

  // AC-4.9
  test("AC-4.9: the rate counts the last 30 days and nothing older", async ({ loggedInPage: page }) => {
    const name = "統計H_30日窓";
    const id = await createHabit(page, { name, kind: "boolean" });

    // Four recent days, one on the oldest day still inside the window (29 days
    // ago), and two that have fallen out of it (30 and 45 days ago).
    await seedDays(page, id, { ...run(0, 3), 29: 1, 30: 1, 45: 1 });

    // The two old rows really are in the table — otherwise "excluded from the
    // rate" would be indistinguishable from "never written".
    const stored = readEntries(id).map((entry) => entry.date);
    expect(stored, `entries for habit ${id}`).toContain(daysAgo(30));
    expect(stored, `entries for habit ${id}`).toContain(daysAgo(45));
    expect(stored).toHaveLength(7);

    await page.reload();
    // 5 of the 7 achieved days fall inside the window: 5 / 30 → 17%.
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 5 });
    await expect(statsRow(page, name)).not.toContainText("7 / 30 日");
  });

  test("AC-4.9: thirty achieved days in the window read 100%", async ({ loggedInPage: page }) => {
    const name = "統計I_全部達成";
    const id = await createHabit(page, { name, kind: "boolean" });

    await seedDays(page, id, run(0, 29));

    await page.reload();
    await expectStats(statsRow(page, name), { current: 30, longest: 30, achieved: 30 });
    await expect(statsRow(page, name)).toContainText("直近 30 日の達成率 100%");
  });

  test("control: a record dated after today neither extends nor bridges a streak", async ({
    loggedInPage: page,
  }) => {
    const name = "統計J_未来日";
    const id = await createHabit(page, { name, kind: "boolean" });

    // Tomorrow achieved; today and yesterday not; two achieved days before that.
    await seedDays(page, id, { [-1]: 1, 2: 1, 3: 1 });
    expect(readEntries(id).map((entry) => entry.date)).toContain(daysAgo(-1));

    await page.reload();
    const row = statsRow(page, name);
    // A day that has not happened is not an achievement: the run really is over.
    await expectStats(row, { current: 0, longest: 2, achieved: 2 });
    await expect(row).not.toContainText("現在ストリーク 1 日");
    await expect(row).not.toContainText("現在ストリーク 3 日");
  });

  test("interpretation: ticking today updates the panel without a reload", async ({ loggedInPage: page }) => {
    const name = "統計K_即時反映";
    const id = await createHabit(page, { name, kind: "boolean" });

    await seedDays(page, id, run(1, 2));
    await page.reload();
    await expectStats(statsRow(page, name), { current: 2, longest: 2, achieved: 2 });

    await checkbox(page, name).check();

    // Not spelled out in an AC, but a statistic that silently disagrees with the
    // row right above it is the failure mode this panel is most likely to have.
    await expectStats(statsRow(page, name), { current: 3, longest: 3, achieved: 3 });
  });

  test("the statistics are per-habit, not per-account", async ({ loggedInPage: page }) => {
    const busy = "統計L_毎日";
    const idle = "統計M_たまに";
    const busyId = await createHabit(page, { name: busy, kind: "boolean" });
    const idleId = await createHabit(page, { name: idle, kind: "boolean" });

    await seedDays(page, busyId, run(0, 6));
    await seedDays(page, idleId, { 0: 1, 5: 1 });

    await page.reload();
    // Two rows on the same screen with different answers: a single global number
    // rendered per row would show the same figure twice.
    await expectStats(statsRow(page, busy), { current: 7, longest: 7, achieved: 7 });
    await expectStats(statsRow(page, idle), { current: 1, longest: 1, achieved: 2 });
  });
});
