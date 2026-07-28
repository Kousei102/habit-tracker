import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "@playwright/test";
import { TODAY, expect, test } from "../fixtures.ts";
import { E2E_DB_PATH } from "../playwright.config.ts";

// Phase 3 acceptance criteria under test here:
//
//   AC-3.1 [E2E] A `boolean` habit, once created, appears in the list.
//   AC-3.2 [E2E] A `numeric` habit shows result and goal readably ("0 / 30 分").
//   AC-3.3 [E2E] Ticking a boolean habit survives a reload.
//   AC-3.4 [E2E] Below target reads 未達成, at/above target reads 達成; both survive a reload.
//   AC-3.5 [E2E] Editing name and target is reflected in the list.
//   AC-3.6 [E2E] A deleted habit leaves the list, but its `entries` rows stay in the DB.
//   AC-3.7        A PUT to an unknown habit id — and to another user's — both answer 404,
//                 indistinguishably.
//   AC-3.8        A second PUT for the same date overwrites instead of duplicating.
//
// Everything on screen is addressed by role and accessible name; the two places
// that look past the UI (the SQLite file, the HTTP status) are exactly the two
// places where an AC talks about something the UI cannot show — "the record is
// still in the database" and "the response must not leak existence".
//
// The clock is pinned by the shared fixture (2026-03-15), so "today" is a
// constant here and a midnight rollover cannot turn a pass into a failure.

// ---------------------------------------------------------------------------
// The database, read directly.
//
// The E2E database is wiped once per run, before the server starts, and is not
// reset between tests — so every test below uses habit names of its own rather
// than assuming an empty list.
// ---------------------------------------------------------------------------

const DB_FILE = path.resolve(import.meta.dirname, "../..", E2E_DB_PATH);

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(DB_FILE);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

type EntryRow = { habit_id: number; date: string; value: number };

function readEntries(habitId: number): EntryRow[] {
  return withDb(
    (db) =>
      db
        .prepare("SELECT habit_id, date, value FROM entries WHERE habit_id = ? ORDER BY date")
        .all(habitId) as unknown as EntryRow[],
  );
}

type HabitRowRecord = { id: number; name: string; target: number | null; archived_at: string | null };

function readHabitRow(habitId: number): HabitRowRecord | undefined {
  return withDb(
    (db) =>
      db.prepare("SELECT id, name, target, archived_at FROM habits WHERE id = ?").get(habitId) as unknown as
        | HabitRowRecord
        | undefined,
  );
}

/**
 * Creates a habit that belongs to somebody else, straight in the database.
 *
 * AC-3.7 is about an id that exists but is not yours, and a single-user UI
 * cannot produce one. Seeding it here keeps the assertion honest: the id really
 * is present in `habits`, so a 404 can only come from the user scoping.
 */
function seedForeignHabit(name: string): number {
  return withDb((db) => {
    const now = new Date().toISOString();

    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get("intruder") as
      | { id: number }
      | undefined;
    const userId =
      existing?.id ??
      Number(
        db
          .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
          .run("intruder", "not-a-real-hash", now).lastInsertRowid,
      );

    const inserted = db
      .prepare(
        `INSERT INTO habits (user_id, name, kind, target, unit, color, sort_order, archived_at, created_at)
         VALUES (?, ?, 'boolean', NULL, NULL, 'blue', 0, NULL, ?)`,
      )
      .run(userId, name, now);

    return Number(inserted.lastInsertRowid);
  });
}

// ---------------------------------------------------------------------------
// Screen vocabulary — role + accessible name only.
// ---------------------------------------------------------------------------

const habitList = (page: Page) => page.getByRole("list", { name: "習慣一覧" });
const habitRow = (page: Page, name: string) => habitList(page).getByRole("listitem").filter({ hasText: name });

const nameField = (page: Page) => page.getByLabel("習慣名");
const targetField = (page: Page) => page.getByLabel("目標値");
const unitField = (page: Page) => page.getByLabel("単位");
const kindOption = (page: Page, label: "チェック式" | "数値式") => page.getByRole("radio", { name: label });
const addButton = (page: Page) => page.getByRole("button", { name: "追加" });
const saveButton = (page: Page) => page.getByRole("button", { name: "保存" });

const checkbox = (page: Page, name: string) => page.getByRole("checkbox", { name });
const amountField = (page: Page, name: string) => page.getByRole("spinbutton", { name });
const editButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} を編集` });
const deleteButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} を削除` });

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

/** The habit's id as the API reports it — the same list the screen is drawn from. */
async function habitIdByName(page: Page, name: string): Promise<number> {
  const response = await page.request.get("/api/habits");
  expect(response.status()).toBe(200);

  const habits = (await response.json()) as Array<{ id: number; name: string }>;
  const found = habits.find((habit) => habit.name === name);
  if (found === undefined) {
    throw new Error(`GET /api/habits does not contain ${JSON.stringify(name)}: ${JSON.stringify(habits)}`);
  }

  return found.id;
}

/** Runs `action` and returns the status of the entry PUT it triggered. */
async function statusOfEntryWrite(page: Page, action: () => Promise<void>): Promise<number> {
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith("/api/entries/") && response.request().method() === "PUT",
  );
  await action();
  return (await pending).status();
}

test.describe("Phase 3 — habits and today's record", () => {
  test("AC-3.1: a boolean habit appears in the list and is really stored", async ({ loggedInPage: page }) => {
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

    // The list must come back from the server, not from the form's own state.
    await page.reload();
    await expect(habitRow(page, name)).toHaveCount(1);
    await expect(checkbox(page, name)).toBeVisible();
  });

  test("AC-3.1 control: submitting an empty name adds nothing", async ({ loggedInPage: page }) => {
    const before = await habitList(page).getByRole("listitem").count();

    await nameField(page).fill("   ");
    await addButton(page).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await page.reload();
    // A blank row appearing here would mean the form reports success it did not earn.
    await expect(habitList(page).getByRole("listitem")).toHaveCount(before);
  });

  test("AC-3.2: a numeric habit shows result and goal together", async ({ loggedInPage: page }) => {
    const name = "瞑想タイム";

    await createNumericHabit(page, name, "30", "分");

    const row = habitRow(page, name);
    // The AC asks for a readable "0 / 30 分" — assert the text a user sees.
    await expect(row).toContainText("0 / 30 分");
    await expect(amountField(page, name)).toBeVisible();
    await expectState(row, "未達成");

    await page.reload();
    await expect(habitRow(page, name)).toContainText("0 / 30 分");
  });

  test("AC-3.3: ticking a boolean habit survives a reload", async ({ loggedInPage: page }) => {
    const name = "水を飲む";
    await createBooleanHabit(page, name);
    const id = await habitIdByName(page, name);

    const status = await statusOfEntryWrite(page, () => checkbox(page, name).check());
    // A write that failed must not be able to leave the screen looking done.
    expect(status).toBe(200);

    await expectState(habitRow(page, name), "達成");
    await expect(checkbox(page, name)).toBeChecked();

    await page.reload();
    await expect(checkbox(page, name)).toBeChecked();
    await expectState(habitRow(page, name), "達成");

    // ...and the day it was recorded against is the pinned "today".
    expect(readEntries(id).map((entry) => entry.date)).toContain(TODAY);
  });

  test("AC-3.3: unticking survives a reload too", async ({ loggedInPage: page }) => {
    const name = "ビタミン";
    await createBooleanHabit(page, name);

    expect(await statusOfEntryWrite(page, () => checkbox(page, name).check())).toBe(200);
    await expectState(habitRow(page, name), "達成");

    expect(await statusOfEntryWrite(page, () => checkbox(page, name).uncheck())).toBe(200);
    await expectState(habitRow(page, name), "未達成");

    // A "clear" that only clears the screen is the mirror image of a save that
    // only saves the screen, and reloading is what tells them apart.
    await page.reload();
    await expect(checkbox(page, name)).not.toBeChecked();
    await expectState(habitRow(page, name), "未達成");
  });

  test("AC-3.4: below the target reads 未達成, at the target reads 達成 — both across a reload", async ({
    loggedInPage: page,
  }) => {
    const name = "ランニング距離";
    await createNumericHabit(page, name, "5", "km");

    expect(await statusOfEntryWrite(page, () => amountField(page, name).fill("3"))).toBe(200);
    await expectState(habitRow(page, name), "未達成");
    await expect(habitRow(page, name)).toContainText("3 / 5 km");

    await page.reload();
    await expect(amountField(page, name)).toHaveValue("3");
    await expectState(habitRow(page, name), "未達成");
    await expect(habitRow(page, name)).toContainText("3 / 5 km");

    // Exactly on target counts as done.
    expect(await statusOfEntryWrite(page, () => amountField(page, name).fill("5"))).toBe(200);
    await expectState(habitRow(page, name), "達成");

    await page.reload();
    await expect(amountField(page, name)).toHaveValue("5");
    await expectState(habitRow(page, name), "達成");
    await expect(habitRow(page, name)).toContainText("5 / 5 km");

    // And above target stays done.
    expect(await statusOfEntryWrite(page, () => amountField(page, name).fill("7.5"))).toBe(200);
    await page.reload();
    await expectState(habitRow(page, name), "達成");
    await expect(habitRow(page, name)).toContainText("7.5 / 5 km");
  });

  test("AC-3.5: editing the name and the target is reflected in the list", async ({ loggedInPage: page }) => {
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
    await expect(habitRow(page, renamed)).toContainText("0 / 50 個");
    await expect(habitRow(page, original)).toHaveCount(0);

    // Same habit, edited — not a new one left beside the old.
    expect(await habitIdByName(page, renamed)).toBe(id);
    expect(readHabitRow(id)?.target).toBe(50);
  });

  test("AC-3.5: renaming a boolean habit works too, and keeps its record", async ({ loggedInPage: page }) => {
    const original = "散歩";
    const renamed = "夕方の散歩";

    await createBooleanHabit(page, original);
    const id = await habitIdByName(page, original);
    expect(await statusOfEntryWrite(page, () => checkbox(page, original).check())).toBe(200);

    await editButton(page, original).click();
    // A check-style habit has no target to offer.
    await expect(targetField(page)).toHaveCount(0);
    await nameField(page).fill(renamed);
    await saveButton(page).click();

    await expect(habitRow(page, renamed)).toHaveCount(1);
    await page.reload();
    await expect(habitRow(page, renamed)).toHaveCount(1);

    // Renaming is not re-creating: same row, and today's tick is still there.
    expect(await habitIdByName(page, renamed)).toBe(id);
    await expectState(habitRow(page, renamed), "達成");
    expect(readEntries(id)).toHaveLength(1);
  });

  test("AC-3.6: deleting removes the habit from the list but keeps its entries", async ({
    loggedInPage: page,
  }) => {
    const name = "腕立て伏せ";
    await createBooleanHabit(page, name);
    const id = await habitIdByName(page, name);

    expect(await statusOfEntryWrite(page, () => checkbox(page, name).check())).toBe(200);
    await expectState(habitRow(page, name), "達成");
    // The record exists before the delete, so "still there afterwards" means something.
    expect(readEntries(id)).toHaveLength(1);

    await deleteButton(page, name).click();
    await expect(habitRow(page, name)).toHaveCount(0);

    await page.reload();
    await expect(habitRow(page, name)).toHaveCount(0);

    // Logical delete: the history the heatmap will need must survive.
    const entries = readEntries(id);
    expect(entries, `entries for habit ${id} were physically deleted`).toHaveLength(1);
    expect(entries[0]?.date).toBe(TODAY);
    expect(entries[0]?.value).toBe(1);

    // The habit row itself is kept and flagged, rather than removed.
    const stored = readHabitRow(id);
    expect(stored, `habits row ${id} was physically deleted`).toBeDefined();
    expect(stored?.archived_at ?? null).not.toBeNull();

    // ...and it is genuinely gone from the user's list, not merely hidden client-side.
    const listed = (await (await page.request.get("/api/habits")).json()) as Array<{ id: number }>;
    expect(listed.map((habit) => habit.id)).not.toContain(id);
  });

  test("AC-3.7: unknown and foreign habit ids are both 404, and indistinguishable", async ({
    loggedInPage: page,
  }) => {
    const foreignId = seedForeignHabit("他人の秘密の習慣");
    // The seed really is in the table — otherwise the 404 below proves nothing.
    expect(readHabitRow(foreignId)).toBeDefined();

    const unknownId = 987_654_321;
    expect(readHabitRow(unknownId)).toBeUndefined();

    const unknown = await page.request.put(`/api/entries/${unknownId}/${TODAY}`, { data: { value: 1 } });
    const foreign = await page.request.put(`/api/entries/${foreignId}/${TODAY}`, { data: { value: 1 } });

    expect(unknown.status()).toBe(404);
    expect(foreign.status()).toBe(404);
    // Byte-identical bodies: any difference is an existence oracle.
    expect(await foreign.text()).toBe(await unknown.text());

    // Nothing was written for the other user's habit.
    expect(readEntries(foreignId)).toHaveLength(0);

    // ...and it is not visible anywhere else either.
    const listed = (await (await page.request.get("/api/habits")).json()) as Array<{ id: number }>;
    expect(listed.map((habit) => habit.id)).not.toContain(foreignId);

    const entries = (await (await page.request.get("/api/entries")).json()) as Array<{ habit_id: number }>;
    expect(entries.map((entry) => entry.habit_id)).not.toContain(foreignId);
  });

  test("AC-3.8: a second PUT for the same date overwrites instead of duplicating", async ({
    loggedInPage: page,
  }) => {
    const created = await page.request.post("/api/habits", {
      data: { name: "スクワット", kind: "numeric", target: 50, unit: "回" },
    });
    expect(created.status()).toBe(201);
    const id = ((await created.json()) as { id: number }).id;

    const first = await page.request.put(`/api/entries/${id}/${TODAY}`, { data: { value: 10 } });
    expect(first.status()).toBe(200);
    const second = await page.request.put(`/api/entries/${id}/${TODAY}`, { data: { value: 25 } });
    expect(second.status()).toBe(200);

    // One row, holding the later value.
    const rows = readEntries(id).filter((entry) => entry.date === TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(25);

    const listed = (await (await page.request.get(`/api/entries?from=${TODAY}&to=${TODAY}`)).json()) as Array<{
      habit_id: number;
      value: number;
    }>;
    const mine = listed.filter((entry) => entry.habit_id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.value).toBe(25);

    // A different date is a different row, not another overwrite.
    const yesterday = "2026-03-14";
    expect((await page.request.put(`/api/entries/${id}/${yesterday}`, { data: { value: 5 } })).status()).toBe(200);
    expect(readEntries(id)).toHaveLength(2);
  });

  test("control: a rejected save is not shown as success", async ({ loggedInPage: page }) => {
    const name = "夜のヨガ";
    await createBooleanHabit(page, name);
    const id = await habitIdByName(page, name);

    await page.route("**/api/entries/**", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "サーバーエラー" }),
      });
    });

    await checkbox(page, name).check();

    // The user has to be told; a silent swallow here is what makes AC-3.3's
    // "still achieved after a reload" impossible to trust.
    await expect(habitRow(page, name).getByRole("alert")).toBeVisible();

    await page.unroute("**/api/entries/**");
    await page.reload();

    await expect(checkbox(page, name)).not.toBeChecked();
    await expectState(habitRow(page, name), "未達成");
    expect(readEntries(id)).toHaveLength(0);
  });

  test("interpretation: a deleted habit no longer accepts records", async ({ loggedInPage: page }) => {
    const name = "使わない習慣";
    await createBooleanHabit(page, name);
    const id = await habitIdByName(page, name);

    await deleteButton(page, name).click();
    await expect(habitRow(page, name)).toHaveCount(0);

    // Not required by an AC; recorded here because Phase 4's streaks will read
    // these rows and the answer needs to be pinned somewhere.
    const response = await page.request.put(`/api/entries/${id}/${TODAY}`, { data: { value: 1 } });
    expect(response.status()).toBe(404);
  });
});
