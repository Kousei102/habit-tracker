import type { Locator, Page } from "@playwright/test";
import {
  addButton,
  amountField,
  byDaysAgo,
  checkbox,
  daysAgo,
  expect,
  expectDashboardReady,
  habitRow,
  kindOption,
  nameField,
  openDashboard,
  run,
  statsList,
  statsRow,
  test,
} from "../fixtures.ts";

// Phase 4 acceptance criteria under test here — still in force after Phase 7,
// which requires the numbers to be unchanged by the move to localStorage
// (AC-7.8):
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
// below is an offset from it — nothing here reads a real calendar, so a run that
// crosses midnight cannot turn a pass into a failure.
//
// History used to be seeded over the API; Phase 7 removed it, so it is seeded
// into the document `localStorage` holds. The assertions are unchanged, which is
// the point: AC-7.8 says the same inputs must still produce the same numbers.
//
// Negative controls are deliberate: streak numbers "look right" very easily. An
// implementation that simply counted records, or that counted every recorded day
// regardless of value, would pass a happy-path assertion. Each test below
// therefore also seeds days that must NOT be counted.

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

/** One habit, its history given as "days before today → value". */
async function openWithHistory(
  page: Page,
  name: string,
  kind: "boolean" | "numeric",
  history: Record<number, number>,
  extra: { target?: number; unit?: string } = {},
): Promise<void> {
  await openDashboard(page, {
    habits: [
      {
        id: 1,
        name,
        kind,
        target: extra.target ?? null,
        unit: extra.unit ?? null,
      },
    ],
    entries: { 1: byDaysAgo(history) },
  });
}

test.describe("Phase 4 — streaks and achievement rate (AC-7.8)", () => {
  test("the panel exists, and a habit with no records reads zero rather than blank", async ({ page }) => {
    const name = "統計A_記録なし";
    await openDashboard(page);

    await expect(page.getByRole("heading", { name: "統計" })).toBeVisible();

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
    await expectDashboardReady(page);
    await expectStats(statsRow(page, name), { current: 0, longest: 0, achieved: 0 });
  });

  test("AC-4.7: five achieved days including today read as a 5 day streak", async ({ page }) => {
    const name = "統計B_連続5日";
    await openWithHistory(page, name, "boolean", run(0, 4));

    await expectStats(statsRow(page, name), { current: 5, longest: 5, achieved: 5 });
  });

  test("AC-4.7 control: unrelated older records do not inflate the current streak", async ({ page }) => {
    const name = "統計C_飛び石";

    // Five in a row ending today, plus two achieved days a week earlier and one
    // recorded-but-not-done day in between. Eight records, seven of them
    // achieved — a "count the records" or "count the achieved days"
    // implementation would say 8 or 7 here, and only a real streak says 5.
    await openWithHistory(page, name, "boolean", { ...run(0, 4), 6: 0, 10: 1, 11: 1 });

    const row = statsRow(page, name);
    await expectStats(row, { current: 5, longest: 5, achieved: 7 });
    await expect(row).not.toContainText("現在ストリーク 7 日");
    await expect(row).not.toContainText("現在ストリーク 8 日");
  });

  test("AC-4.8: breaking one day in the middle shortens the current streak", async ({ page }) => {
    const name = "統計D_途中で途切れる";
    await openWithHistory(page, name, "boolean", run(0, 4));
    await expectStats(statsRow(page, name), { current: 5, longest: 5, achieved: 5 });

    // Two days ago is undone: the run ending today is now today + yesterday, and
    // the best run left in the history is the two days before the break.
    await openWithHistory(page, name, "boolean", { ...run(0, 4), 2: 0 });
    await expectStats(statsRow(page, name), { current: 2, longest: 2, achieved: 4 });
  });

  test("AC-4.8/AC-4.2: unticking today leaves the streak at four, not zero", async ({ page }) => {
    const name = "統計E_今日を外す";
    await openWithHistory(page, name, "boolean", run(0, 4));

    await expect(checkbox(page, name)).toBeChecked();
    await expectStats(statsRow(page, name), { current: 5, longest: 5, achieved: 5 });

    await checkbox(page, name).uncheck();

    // Today is not over. The four days up to yesterday still stand, so the
    // count drops by exactly one — it does not collapse to 0. Asserted both
    // live and after a reload, so neither the in-memory recompute nor the
    // stored document can be the only one that is right.
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 4 });

    await page.reload();
    await expectDashboardReady(page);
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 4 });
  });

  test("AC-4.2: with today never recorded, the streak counts back from yesterday", async ({ page }) => {
    const name = "統計F_今日は未記録";

    // Yesterday and the three days before it. Nothing at all for today.
    await openWithHistory(page, name, "boolean", run(1, 4));
    await expect(checkbox(page, name)).not.toBeChecked();
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 4 });

    // An explicit "not done today" record must read the same as no record: it is
    // still only today, and today is not over.
    await openWithHistory(page, name, "boolean", { ...run(1, 4), 0: 0 });
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 4 });

    // ...but yesterday IS over. Undoing it really does break the run: today's
    // grace reaches back one day, not two.
    await openWithHistory(page, name, "boolean", { ...run(1, 4), 0: 0, 1: 0 });
    await expectStats(statsRow(page, name), { current: 0, longest: 3, achieved: 3 });
  });

  test("AC-4.6: a numeric day below its target is not counted", async ({ page }) => {
    const name = "統計G_数値目標30";

    // today 10 (short), yesterday 30 (exactly on target), 2 days ago 45 (over),
    // 3 days ago 29 (one short), 4 days ago 30.
    await openWithHistory(page, name, "numeric", { 0: 10, 1: 30, 2: 45, 3: 29, 4: 30 }, { target: 30, unit: "分" });

    const row = statsRow(page, name);
    // Five recorded days, three of them achievements. Today fell short but is
    // not over, so the run is yesterday + the day before.
    await expectStats(row, { current: 2, longest: 2, achieved: 3 });
    await expect(row).not.toContainText("現在ストリーク 5 日");
    await expect(row).not.toContainText("直近 30 日の達成率 17%（5 / 30 日）");
    // The row on the today panel agrees with the statistic: both say not done.
    await expect(habitRow(page, name)).toContainText("10 / 30 分");

    // Raising the short day to exactly the target joins the two runs.
    await openWithHistory(
      page,
      name,
      "numeric",
      { 0: 10, 1: 30, 2: 45, 3: 30, 4: 30 },
      { target: 30, unit: "分" },
    );
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 4 });
  });

  test("AC-4.9: the rate counts the last 30 days and nothing older", async ({ page }) => {
    const name = "統計H_30日窓";

    // Four recent days, one on the oldest day still inside the window (29 days
    // ago), and two that have fallen out of it (30 and 45 days ago).
    const history = { ...run(0, 3), 29: 1, 30: 1, 45: 1 };
    await openWithHistory(page, name, "boolean", history);

    // The two old records really are stored — otherwise "excluded from the rate"
    // would be indistinguishable from "never written". Read in the habit's own
    // heatmap view, where a cell is labelled with that habit's own reading.
    await page.getByLabel("表示する習慣").selectOption({ label: name });
    const cell = (date: string) => page.getByRole("gridcell", { name: `${date} 達成` });
    await expect(cell(daysAgo(30)), "the 30-day-old record is not drawn").toHaveCount(1);
    await expect(cell(daysAgo(45)), "the 45-day-old record is not drawn").toHaveCount(1);

    // 5 of the 7 achieved days fall inside the window: 5 / 30 → 17%.
    await expectStats(statsRow(page, name), { current: 4, longest: 4, achieved: 5 });
    await expect(statsRow(page, name)).not.toContainText("7 / 30 日");
  });

  test("AC-4.9: thirty achieved days in the window read 100%", async ({ page }) => {
    const name = "統計I_全部達成";
    await openWithHistory(page, name, "boolean", run(0, 29));

    await expectStats(statsRow(page, name), { current: 30, longest: 30, achieved: 30 });
    await expect(statsRow(page, name)).toContainText("直近 30 日の達成率 100%");
  });

  test("control: a record dated after today neither extends nor bridges a streak", async ({ page }) => {
    const name = "統計J_未来日";

    // Tomorrow achieved; today and yesterday not; two achieved days before that.
    await openWithHistory(page, name, "boolean", { [-1]: 1, 2: 1, 3: 1 });

    const row = statsRow(page, name);
    // A day that has not happened is not an achievement: the run really is over.
    await expectStats(row, { current: 0, longest: 2, achieved: 2 });
    await expect(row).not.toContainText("現在ストリーク 1 日");
    await expect(row).not.toContainText("現在ストリーク 3 日");
  });

  test("interpretation: ticking today updates the panel without a reload", async ({ page }) => {
    const name = "統計K_即時反映";
    await openWithHistory(page, name, "boolean", run(1, 2));
    await expectStats(statsRow(page, name), { current: 2, longest: 2, achieved: 2 });

    await checkbox(page, name).check();

    // A statistic that silently disagrees with the row right above it is the
    // failure mode this panel is most likely to have.
    await expectStats(statsRow(page, name), { current: 3, longest: 3, achieved: 3 });
  });

  test("interpretation: typing a numeric value updates the panel without a reload", async ({ page }) => {
    const name = "統計K2_数値即時";
    await openWithHistory(page, name, "numeric", run(1, 2, 30), { target: 30, unit: "分" });
    await expectStats(statsRow(page, name), { current: 2, longest: 2, achieved: 2 });

    const field = amountField(page, name);
    await field.fill("30");
    await field.blur();

    await expectStats(statsRow(page, name), { current: 3, longest: 3, achieved: 3 });
  });

  test("the statistics are per-habit, not per-account", async ({ page }) => {
    const busy = "統計L_毎日";
    const idle = "統計M_たまに";

    await openDashboard(page, {
      habits: [
        { id: 1, name: busy, kind: "boolean" },
        { id: 2, name: idle, kind: "boolean" },
      ],
      entries: { 1: byDaysAgo(run(0, 6)), 2: byDaysAgo({ 0: 1, 5: 1 }) },
    });

    // Two rows on the same screen with different answers: a single global number
    // rendered per row would show the same figure twice.
    await expect(statsList(page).getByRole("listitem")).toHaveCount(2);
    await expectStats(statsRow(page, busy), { current: 7, longest: 7, achieved: 7 });
    await expectStats(statsRow(page, idle), { current: 1, longest: 1, achieved: 2 });
  });

  test("a deleted habit's records do not leak into another habit's statistics", async ({ page }) => {
    // Phase 7 keeps deleted habits and their records in the same document as the
    // live ones. Nothing may count them.
    await openDashboard(page, {
      habits: [
        { id: 1, name: "統計N_生きている", kind: "boolean" },
        { id: 2, name: "統計N_削除済み", kind: "boolean", archived_at: "2026-03-10T00:00:00.000Z" },
      ],
      entries: { 1: byDaysAgo(run(0, 1)), 2: byDaysAgo(run(0, 20)) },
    });

    await expect(statsList(page).getByRole("listitem")).toHaveCount(1);
    await expectStats(statsRow(page, "統計N_生きている"), { current: 2, longest: 2, achieved: 2 });
  });
});
