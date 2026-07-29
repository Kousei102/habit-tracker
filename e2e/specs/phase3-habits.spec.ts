import type { Locator, Page } from "@playwright/test";
import {
  STORAGE_KEY,
  TODAY,
  addButton,
  amountField,
  checkbox,
  daysAgo,
  deleteButton,
  editButton,
  expect,
  expectDashboardReady,
  habitList,
  habitRow,
  kindOption,
  nameField,
  openDashboard,
  readStorage,
  saveButton,
  targetField,
  test,
  unitField,
} from "../fixtures.ts";

// Phase 3 acceptance criteria under test here — all of them still in force after
// Phase 7, which requires exactly this behaviour from the new storage (AC-7.7):
//
//   AC-3.1 [E2E] A `boolean` habit, once created, appears in the list.
//   AC-3.2 [E2E] A `numeric` habit shows result and goal readably ("0 / 30 分").
//   AC-3.3 [E2E] Ticking a boolean habit survives a reload.
//   AC-3.4 [E2E] Below target reads 未達成, at/above target reads 達成; both survive a reload.
//   AC-3.5 [E2E] Editing name and target is reflected in the list.
//   AC-3.6 [E2E] A deleted habit leaves the list, but its records stay stored.
//
// AC-3.7 / AC-3.8 were retired with the HTTP API. What they were protecting —
// "a record cannot be written against a habit that is not there" and "a second
// write for the same day replaces rather than duplicates" — is still meaningful
// at the storage layer, and is pinned at the bottom of this file.
//
// Everything on screen is addressed by role and accessible name. The one place
// that looks past the UI is `localStorage`, which is where the AC about "the
// record is still there after a delete" now points.
//
// The clock is pinned by the shared fixture (2026-03-15), so "today" is a
// constant here and a midnight rollover cannot turn a pass into a failure.

// ---------------------------------------------------------------------------
// The stored document, read directly.
// ---------------------------------------------------------------------------

type StoredHabit = {
  id: number;
  name: string;
  kind: string;
  target: number | null;
  archived_at: string | null;
};
type StoredDocument = {
  version: number;
  next_habit_id: number;
  habits: StoredHabit[];
  entries: Record<string, Record<string, number>>;
};

async function readDocument(page: Page): Promise<StoredDocument> {
  const text = await readStorage(page);
  expect(text, `nothing is stored under "${STORAGE_KEY}"`).not.toBeNull();
  return JSON.parse(text as string) as StoredDocument;
}

/** The habit's stored id, by the name shown on screen. */
async function habitIdByName(page: Page, name: string): Promise<number> {
  const document = await readDocument(page);
  const found = document.habits.find((habit) => habit.name === name);
  if (found === undefined) {
    throw new Error(`the stored document has no habit named ${JSON.stringify(name)}`);
  }
  return found.id;
}

/** Records for one habit, as `[date, value]` pairs sorted by date. */
async function readEntries(page: Page, habitId: number): Promise<Array<[string, number]>> {
  const document = await readDocument(page);
  return Object.entries(document.entries[String(habitId)] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
}

async function readHabitRow(page: Page, habitId: number): Promise<StoredHabit | undefined> {
  return (await readDocument(page)).habits.find((habit) => habit.id === habitId);
}

// ---------------------------------------------------------------------------

/**
 * Asserts the row reads as done / not done, in words a user can read.
 *
 * Both halves matter: `達成` is a substring of `未達成`, so a test that only
 * looked for the positive string would pass while the screen said the opposite.
 */
async function expectState(row: Locator, state: "達成" | "未達成"): Promise<void> {
  const opposite = state === "達成" ? "未達成" : "達成";
  await expect(row.getByText(state, { exact: true })).toBeVisible();
  await expect(row.getByText(opposite, { exact: true })).toHaveCount(0);
}

async function createBooleanHabit(page: Page, name: string): Promise<void> {
  await nameField(page).fill(name);
  await kindOption(page, "チェック式").check();
  await addButton(page).click();
  await expect(habitRow(page, name)).toBeVisible();
}

async function createNumericHabit(page: Page, name: string, target: string, unit: string): Promise<void> {
  await nameField(page).fill(name);
  await kindOption(page, "数値式").check();
  await targetField(page).fill(target);
  await unitField(page).fill(unit);
  await addButton(page).click();
  await expect(habitRow(page, name)).toBeVisible();
}

test.describe("Phase 3 — habits and today's record (AC-7.7)", () => {
  test.beforeEach(async ({ page }) => {
    // Every test starts from an empty browser: contexts are not shared, so the
    // list below really is only what this test created.
    await openDashboard(page);
  });

  test("AC-3.1: a boolean habit appears in the list and is really stored", async ({ page }) => {
    const name = "朝のストレッチ";

    // Nothing by that name before the user asks for it — otherwise the
    // assertion below could pass without the form doing anything.
    await expect(habitRow(page, name)).toHaveCount(0);

    await createBooleanHabit(page, name);

    const row = habitRow(page, name);
    await expect(row).toHaveCount(1);
    // A check-style habit is recorded with a checkbox, not a number box.
    await expect(checkbox(page, name)).toBeVisible();
    await expect(amountField(page, name)).toHaveCount(0);
    await expectState(row, "未達成");

    // The list must come back from storage, not from the form's own state.
    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, name)).toHaveCount(1);
    await expect(checkbox(page, name)).toBeVisible();
  });

  test("AC-3.1 control: submitting an empty name adds nothing", async ({ page }) => {
    // One habit of this test's own first, so the count below is non-zero and an
    // assertion about "unchanged" cannot be satisfied by an unrendered list.
    await createBooleanHabit(page, "空欄チェックの基準");

    const rows = habitList(page).getByRole("listitem");
    const before = await rows.count();
    expect(before).toBeGreaterThan(0);

    await nameField(page).fill("   ");
    await addButton(page).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await page.reload();
    await expectDashboardReady(page);
    // A blank row appearing here would mean the form reports success it did not earn.
    await expect(rows).toHaveCount(before);
  });

  test("AC-3.2: a numeric habit shows result and goal together", async ({ page }) => {
    const name = "瞑想タイム";

    await createNumericHabit(page, name, "30", "分");

    const row = habitRow(page, name);
    // The AC asks for a readable "0 / 30 分" — assert the text a user sees.
    await expect(row).toContainText("0 / 30 分");
    await expect(amountField(page, name)).toBeVisible();
    await expectState(row, "未達成");

    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, name)).toContainText("0 / 30 分");
  });

  test("AC-3.3: ticking a boolean habit survives a reload", async ({ page }) => {
    const name = "水を飲む";
    await createBooleanHabit(page, name);
    const id = await habitIdByName(page, name);

    await checkbox(page, name).check();

    await expectState(habitRow(page, name), "達成");
    await expect(checkbox(page, name)).toBeChecked();

    // The write really landed before the reload — no request to wait for, so
    // the storage is the thing to ask.
    expect(await readEntries(page, id)).toEqual([[TODAY, 1]]);

    await page.reload();
    await expectDashboardReady(page);
    await expect(checkbox(page, name)).toBeChecked();
    await expectState(habitRow(page, name), "達成");
  });

  test("AC-3.3: unticking survives a reload too", async ({ page }) => {
    const name = "ビタミン";
    await createBooleanHabit(page, name);

    await checkbox(page, name).check();
    await expectState(habitRow(page, name), "達成");

    await checkbox(page, name).uncheck();
    await expectState(habitRow(page, name), "未達成");

    // A "clear" that only clears the screen is the mirror image of a save that
    // only saves the screen, and reloading is what tells them apart.
    await page.reload();
    await expectDashboardReady(page);
    await expect(checkbox(page, name)).not.toBeChecked();
    await expectState(habitRow(page, name), "未達成");
  });

  test("AC-3.4: below the target reads 未達成, at the target reads 達成 — both across a reload", async ({
    page,
  }) => {
    const name = "ランニング距離";
    await createNumericHabit(page, name, "5", "km");

    await amountField(page, name).fill("3");
    await amountField(page, name).blur();
    await expectState(habitRow(page, name), "未達成");
    await expect(habitRow(page, name)).toContainText("3 / 5 km");

    await page.reload();
    await expectDashboardReady(page);
    await expect(amountField(page, name)).toHaveValue("3");
    await expectState(habitRow(page, name), "未達成");
    await expect(habitRow(page, name)).toContainText("3 / 5 km");

    // Exactly on target counts as done.
    await amountField(page, name).fill("5");
    await amountField(page, name).blur();
    await expectState(habitRow(page, name), "達成");

    await page.reload();
    await expectDashboardReady(page);
    await expect(amountField(page, name)).toHaveValue("5");
    await expectState(habitRow(page, name), "達成");
    await expect(habitRow(page, name)).toContainText("5 / 5 km");

    // And above target stays done.
    await amountField(page, name).fill("7.5");
    await amountField(page, name).blur();
    await page.reload();
    await expectDashboardReady(page);
    await expectState(habitRow(page, name), "達成");
    await expect(habitRow(page, name)).toContainText("7.5 / 5 km");
  });

  test("AC-3.5: editing the name and the target is reflected in the list", async ({ page }) => {
    const original = "英単語";
    const renamed = "ドイツ語の暗記";

    await createNumericHabit(page, original, "20", "個");
    const id = await habitIdByName(page, original);

    await editButton(page, original).click();
    await nameField(page).fill(renamed);
    await targetField(page).fill("50");
    await saveButton(page).click();

    const row = habitRow(page, renamed);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("0 / 50 個");
    await expect(habitRow(page, original)).toHaveCount(0);

    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, renamed)).toContainText("0 / 50 個");
    await expect(habitRow(page, original)).toHaveCount(0);

    // Same habit, edited — not a new one left beside the old.
    expect(await habitIdByName(page, renamed)).toBe(id);
    expect((await readHabitRow(page, id))?.target).toBe(50);
    expect((await readDocument(page)).habits).toHaveLength(1);
  });

  test("AC-3.5: renaming a boolean habit works too, and keeps its record", async ({ page }) => {
    const original = "散歩";
    const renamed = "夕方の散歩";

    await createBooleanHabit(page, original);
    const id = await habitIdByName(page, original);
    await checkbox(page, original).check();
    await expectState(habitRow(page, original), "達成");

    await editButton(page, original).click();
    // A check-style habit has no target to offer.
    await expect(targetField(page)).toHaveCount(0);
    await nameField(page).fill(renamed);
    await saveButton(page).click();

    await expect(habitRow(page, renamed)).toHaveCount(1);
    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, renamed)).toHaveCount(1);

    // Renaming is not re-creating: same row, and today's tick is still there.
    expect(await habitIdByName(page, renamed)).toBe(id);
    await expectState(habitRow(page, renamed), "達成");
    expect(await readEntries(page, id)).toEqual([[TODAY, 1]]);
  });

  test("AC-3.6 / AC-7.7: deleting removes the habit from the list but keeps its records", async ({ page }) => {
    const name = "腕立て伏せ";
    await createBooleanHabit(page, name);
    const id = await habitIdByName(page, name);

    await checkbox(page, name).check();
    await expectState(habitRow(page, name), "達成");
    // The record exists before the delete, so "still there afterwards" means something.
    expect(await readEntries(page, id)).toEqual([[TODAY, 1]]);

    await deleteButton(page, name).click();
    await expect(habitRow(page, name)).toHaveCount(0);

    await page.reload();
    // "Not in the list" has to be read from a rendered list.
    await expectDashboardReady(page);
    await expect(habitRow(page, name)).toHaveCount(0);

    // Logical delete: the history Phase 8's export will need must survive.
    expect(
      await readEntries(page, id),
      `entries for habit ${id} were physically deleted`,
    ).toEqual([[TODAY, 1]]);

    // The habit itself is kept and flagged, rather than removed.
    const stored = await readHabitRow(page, id);
    expect(stored, `habit ${id} was physically deleted`).toBeDefined();
    expect(stored?.archived_at ?? null).not.toBeNull();
  });

  test("AC-3.6: the undo brings the habit back with the records it kept", async ({ page }) => {
    const name = "P3_取り消し_腕立て";
    await createBooleanHabit(page, name);
    const id = await habitIdByName(page, name);
    await checkbox(page, name).check();

    await deleteButton(page, name).click();
    await expect(habitRow(page, name)).toHaveCount(0);

    await page.getByRole("button", { name: "削除を取り消す" }).click();
    await expect(habitRow(page, name)).toBeVisible();

    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, name)).toBeVisible();
    await expect(checkbox(page, name)).toBeChecked();
    expect((await readHabitRow(page, id))?.archived_at ?? null).toBeNull();
  });

  // -------------------------------------------------------------------------
  // What AC-3.7 / AC-3.8 were protecting, now that there is no HTTP layer.
  // -------------------------------------------------------------------------

  test("AC-3.8 (storage): recording the same day twice replaces the value instead of duplicating it", async ({
    page,
  }) => {
    const name = "スクワット";
    await createNumericHabit(page, name, "50", "回");
    const id = await habitIdByName(page, name);

    const field = amountField(page, name);
    await field.fill("10");
    await field.blur();
    await field.fill("25");
    await field.blur();

    // One day, one value — the later one.
    await expect
      .poll(async () => await readEntries(page, id))
      .toEqual([[TODAY, 25]]);

    await page.reload();
    await expectDashboardReady(page);
    await expect(amountField(page, name)).toHaveValue("25");
  });

  test("interpretation: a deleted habit is gone from every view, and its records stay put", async ({ page }) => {
    const name = "使わない習慣";
    await createBooleanHabit(page, name);
    const id = await habitIdByName(page, name);
    await checkbox(page, name).check();

    await deleteButton(page, name).click();
    await expect(habitRow(page, name)).toHaveCount(0);

    await page.reload();
    await expectDashboardReady(page);

    // Not on the today panel and not in the statistics…
    await expect(habitRow(page, name)).toHaveCount(0);
    await expect(page.getByRole("list", { name: "習慣の統計" }).getByRole("listitem")).toHaveCount(0);
    // …but still in the heatmap's picker, named as deleted, because its records
    // are still drawn.
    await expect(page.getByRole("option", { name: `${name}（削除済み）` })).toHaveCount(1);
    expect(await readEntries(page, id)).toEqual([[TODAY, 1]]);
  });

  test("interpretation: a record dated before the habit existed is still kept and shown", async ({ page }) => {
    // Nothing in the app clamps by `created_at` (AC-4.9 is explicit about it),
    // and with the browser's clock pinned, `created_at` is in the future
    // relative to the seeded history of every other spec here.
    await openDashboard(page, {
      habits: [{ id: 1, name: "P3_過去の記録", kind: "boolean", created_at: "2026-03-15T09:00:00.000Z" }],
      entries: { 1: { [daysAgo(10)]: 1 } },
    });

    // Read in the habit's own view: the default 「全体」 view labels a cell
    // "0 / 1 習慣 達成", which is a count and not this habit's own reading.
    await page.getByLabel("表示する習慣").selectOption({ label: "P3_過去の記録" });
    await expect(page.getByRole("gridcell", { name: `${daysAgo(10)} 達成` })).toHaveCount(1);
  });
});
