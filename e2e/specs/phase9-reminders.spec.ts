import fs from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
  amountField,
  byDaysAgo,
  checkbox,
  expect,
  expectDashboardReady,
  habitRow,
  openDashboard,
  readStorage,
  seedRaw,
  test,
} from "../fixtures.ts";

/*
 * Phase 9 — the reminder and the app-icon badge.
 *
 * The acceptance criteria under test (docs/phases.md):
 *
 *   AC-9.1  [単体] Pending is decided by `isAchieved()` alone. Covered in
 *                  client/src/data/reminder.test.ts, not here.
 *   AC-9.2  [単体] No habits means no sentence. Same file.
 *   AC-9.3  [E2E]  The count and the names of what is undone are on screen.
 *   AC-9.4  [E2E]  Recording the last one flips the sentence without a reload.
 *   AC-9.5  [E2E]  The badge is opt-in behind a press; loading the page asks for
 *                  no permission.
 *   AC-9.6  [E2E]  Once granted, the pending count reaches `setAppBadge`, and
 *                  reaching zero clears it.
 *   AC-9.7  [E2E]  A denied permission leaves the badge off, says so, and raises
 *                  no uncaught error.
 *   AC-9.8  [E2E]  A browser without the Badging API still runs the app.
 *   AC-9.9  [E2E]  The preference survives a reload, an import and a reset, and
 *                  lives outside the document.
 *   AC-9.10 [E2E]  A new day recomputes the count and the badge.
 *   AC-9.11 [E2E]  An unreadable document shows no reminder and does not block
 *                  the backup panel (AC-8.12).
 *   AC-9.12 [E2E]  375px: nothing overflows, the badge button is reachable.
 *
 * Three rules run through the file.
 *
 * **The browser APIs are stubbed, and that is not optional.** Chromium exposes
 * `setAppBadge` but draws nothing unless the app is installed, and a permission
 * prompt cannot be answered by a test. So `stubBadge()` installs both and *records
 * every call*, which makes the assertions about what the app asked for exact
 * rather than inferred from pixels. Every stub is paired with a control that would
 * fail if the app stopped calling it.
 *
 * **The clock is pinned** by the shared fixture (2026-03-15). AC-9.10 moves it
 * forward deliberately with `page.clock`; nothing here reads a real calendar.
 *
 * **An unavailable badge is never an error.** A denied permission and a missing
 * API are ordinary states of a real phone, so those tests watch `pageerror` and
 * require the app to keep working, not merely to avoid crashing visibly.
 */

const BADGE_KEY = "habit-tracker.badge";

const WALK = "リマインダ_散歩";
const READ = "リマインダ_読書";

/** Two habits, one of each kind, with a week of history behind them. */
const SEED = {
  habits: [
    { id: 1, name: WALK, kind: "boolean" as const },
    { id: 2, name: READ, kind: "numeric" as const, target: 30, unit: "分" },
  ],
  entries: {
    1: byDaysAgo({ 1: 1, 2: 1, 3: 1 }),
    // 10 of a 30 minute goal *today*: recorded, and still not achieved. The badge
    // must count it, which is only true if the count goes through `isAchieved()`.
    2: { ...byDaysAgo({ 1: 30, 2: 30 }), ...byDaysAgo({ 0: 10 }) },
  },
};

// ---------------------------------------------------------------------------
// Screen vocabulary. Role and accessible name, except for the two lines whose
// text is computed — those carry a test id, as elsewhere in this suite.
// ---------------------------------------------------------------------------

const remindersSection = (page: Page) => page.locator("#reminders");
const remindersHeading = (page: Page) => page.getByRole("heading", { name: "今日のリマインダー" });
const reminderMessage = (page: Page) => page.getByTestId("reminder-message");
const badgeState = (page: Page) => page.getByTestId("badge-state");
const enableBadgeButton = (page: Page) =>
  page.getByRole("button", { name: "アイコンにバッジを表示する" });
const disableBadgeButton = (page: Page) => page.getByRole("button", { name: "バッジの表示をやめる" });
const backupHeading = (page: Page) => page.getByRole("heading", { name: "バックアップ" });
const exportButton = (page: Page) => page.getByRole("button", { name: "エクスポート" });
const fileField = (page: Page) => page.getByLabel("バックアップファイル");
const confirmImportButton = (page: Page) => page.getByRole("button", { name: "インポートを実行" });
const openResetButton = (page: Page) => page.getByRole("button", { name: "データを初期化する" });
const resetAcknowledgement = (page: Page) =>
  page.getByRole("checkbox", { name: "記録がすべて消えることを理解しました" });
const runResetButton = (page: Page) => page.getByRole("button", { name: "すべての記録を削除する" });

// ---------------------------------------------------------------------------
// Stubs and readers
// ---------------------------------------------------------------------------

/** What the app pushed to the icon: a number, or a clear. */
type BadgeCall = number | "clear";

type StubOptions = {
  /** What `Notification.permission` says before anything is asked. */
  permission?: "default" | "granted" | "denied";
  /** What a request resolves to — and what `permission` reads as afterwards. */
  answer?: "granted" | "denied";
  /** False removes the Badging API entirely (AC-9.8). */
  support?: boolean;
};

/**
 * Installs recording stubs for the Badging API and the permission request.
 *
 * Must be called before the first navigation. The counters live on `window`, so
 * they reset with every document — which is what makes an assertion after a
 * reload a statement about that load and not about the whole test.
 */
async function stubBadge(page: Page, options: StubOptions = {}): Promise<void> {
  const config = {
    permission: options.permission ?? "default",
    answer: options.answer ?? "granted",
    support: options.support ?? true,
  };

  await page.addInitScript((settings) => {
    const store = window as unknown as { __badge: BadgeCall[]; __asked: number };
    store.__badge = [];
    store.__asked = 0;

    const nav = navigator as Navigator & Record<string, unknown>;

    if (settings.support) {
      nav["setAppBadge"] = async (count?: number) => {
        store.__badge.push(count ?? 0);
      };
      nav["clearAppBadge"] = async () => {
        store.__badge.push("clear");
      };
    } else {
      // Chromium ships these on the prototype, so shadowing the instance is not
      // enough to imitate a browser that never had them.
      const proto = Navigator.prototype as unknown as Partial<Record<string, unknown>>;
      delete proto["setAppBadge"];
      delete proto["clearAppBadge"];

      const own = nav as unknown as Partial<Record<string, unknown>>;
      delete own["setAppBadge"];
      delete own["clearAppBadge"];
    }

    const describe = (value: string) => {
      Object.defineProperty(Notification, "permission", { configurable: true, get: () => value });
    };
    describe(settings.permission);

    (Notification as unknown as Record<string, unknown>)["requestPermission"] = async () => {
      store.__asked += 1;
      // A real grant becomes the standing state, so the stub does too — otherwise
      // a reload would forget it and AC-9.9 would be testing nothing.
      describe(settings.answer);
      return settings.answer;
    };
  }, config);
}

/** Every badge call this document made, oldest first. */
async function badgeCalls(page: Page): Promise<BadgeCall[]> {
  return page.evaluate(() => (window as unknown as { __badge: BadgeCall[] }).__badge);
}

/** The number currently on the icon, as the app last set it. */
async function currentBadge(page: Page): Promise<BadgeCall | undefined> {
  const calls = await badgeCalls(page);
  return calls.at(-1);
}

/** How many times the app asked the user for the notification permission. */
async function permissionRequests(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __asked: number }).__asked);
}

async function readBadgePreference(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), BADGE_KEY);
}

/** Turns the badge on through the UI and waits for the panel to agree. */
async function optIn(page: Page): Promise<void> {
  await enableBadgeButton(page).click();
  await expect(disableBadgeButton(page)).toBeVisible();
}

async function expectWithinViewportWidth(page: Page, target: Locator, what: string): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport");
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box, `${what} has no box`).not.toBeNull();
  expect(box?.x ?? -1, `${what} starts off the left edge`).toBeGreaterThanOrEqual(-1);
  expect((box?.x ?? 0) + (box?.width ?? 0), `${what} runs past the right edge`).toBeLessThanOrEqual(
    viewport.width + 1,
  );
}

// ---------------------------------------------------------------------------

test.describe("Phase 9 — what is still undone", () => {
  test("AC-9.3: the count and the names are on screen", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, SEED);

    await expect(remindersHeading(page)).toBeVisible();
    // 10 of 30 minutes counts as undone: the sentence agrees with `isAchieved()`
    // rather than with "has a record today".
    await expect(reminderMessage(page)).toContainText("今日はまだ 2 件未達成です");
    await expect(reminderMessage(page)).toContainText(WALK);
    await expect(reminderMessage(page)).toContainText(READ);
  });

  test("AC-9.4: recording the last one flips the sentence, without a reload", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, SEED);

    await checkbox(page, WALK).check();
    await expect(reminderMessage(page)).toContainText("今日はまだ 1 件未達成です");
    await expect(reminderMessage(page)).toContainText(READ);
    await expect(reminderMessage(page)).not.toContainText(WALK);

    await amountField(page, READ).fill("30");
    await expect(habitRow(page, READ)).toContainText("30 / 30 分");
    await expect(reminderMessage(page)).toHaveText("今日の習慣はすべて達成しています。");
  });

  test("AC-9.4 control: falling back below the goal makes it undone again", async ({ page }) => {
    // Without this, "the sentence changed" could be satisfied by a panel that
    // only ever counts down.
    await stubBadge(page);
    await openDashboard(page, SEED);

    await checkbox(page, WALK).check();
    await amountField(page, READ).fill("30");
    await expect(reminderMessage(page)).toHaveText("今日の習慣はすべて達成しています。");

    await amountField(page, READ).fill("29");
    await expect(reminderMessage(page)).toContainText("今日はまだ 1 件未達成です");
    await expect(reminderMessage(page)).toContainText(READ);
  });

  test("AC-9.2: a browser with no habits is not given a status report", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page);

    // The card is present — the badge control lives there — but it says nothing
    // about habits that do not exist.
    await expect(remindersHeading(page)).toBeVisible();
    await expect(reminderMessage(page)).toHaveCount(0);
  });
});

test.describe("Phase 9 — the badge is opt-in", () => {
  test("AC-9.5: loading the page asks for no permission", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, SEED);

    // The button is the only way in, and it has not been pressed.
    await expect(enableBadgeButton(page)).toBeVisible();
    await expect(badgeState(page)).toContainText("停止中");
    expect(await permissionRequests(page), "the app prompted on load").toBe(0);
  });

  test("AC-9.5 control: pressing the button does ask", async ({ page }) => {
    // Proves the counter above can move, so a zero there means something.
    await stubBadge(page);
    await openDashboard(page, SEED);

    await optIn(page);
    expect(await permissionRequests(page)).toBe(1);
  });

  test("AC-9.6: the pending count reaches the icon, and zero clears it", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, SEED);

    // Off to begin with: the icon is actively cleared rather than left alone, so
    // a badge from an earlier session cannot outlive the preference.
    await expect.poll(() => currentBadge(page)).toBe("clear");

    await optIn(page);
    await expect.poll(() => currentBadge(page)).toBe(2);
    await expect(badgeState(page)).toContainText("表示中（2）");

    await checkbox(page, WALK).check();
    await expect.poll(() => currentBadge(page)).toBe(1);

    await amountField(page, READ).fill("30");
    await expect.poll(() => currentBadge(page)).toBe("clear");
    await expect(badgeState(page)).toContainText("未達成がないので数字は出ません");
  });

  test("AC-9.6: turning it off clears the icon", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, SEED);
    await optIn(page);
    await expect.poll(() => currentBadge(page)).toBe(2);

    await disableBadgeButton(page).click();

    await expect(enableBadgeButton(page)).toBeVisible();
    // Not merely "stops updating": the number is drawn by the OS and outlives the
    // page, so a badge left behind would keep nagging after being switched off.
    await expect.poll(() => currentBadge(page)).toBe("clear");
    await expect(badgeState(page)).toContainText("停止中");
  });

  test("AC-9.7: a denied permission leaves the badge off and says why", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await stubBadge(page, { answer: "denied" });
    await openDashboard(page, SEED);

    await enableBadgeButton(page).click();

    await expect(badgeState(page)).toContainText("通知を許可していないため");
    await expect(disableBadgeButton(page)).toHaveCount(0);
    expect(await readBadgePreference(page), "a denial was recorded as consent").not.toBe("on");

    // The app is still an app.
    await expect(reminderMessage(page)).toContainText("今日はまだ 2 件未達成です");
    await checkbox(page, WALK).check();
    await expect(reminderMessage(page)).toContainText("今日はまだ 1 件未達成です");
    expect(pageErrors, "a denied permission reached the page as an uncaught error").toEqual([]);
  });

  test("AC-9.8: a browser without the Badging API still runs the app", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await stubBadge(page, { support: false });
    await openDashboard(page, SEED);

    // Guard against a vacuous control: if Chromium still had the API, this test
    // would be checking the supported path under a misleading name.
    const present = await page.evaluate(
      () => typeof (navigator as Navigator & Record<string, unknown>)["setAppBadge"],
    );
    expect(present, "the Badging API was not actually removed").toBe("undefined");

    await expect(badgeState(page)).toContainText("対応していません");
    await expect(enableBadgeButton(page)).toHaveCount(0);

    await expect(reminderMessage(page)).toContainText("今日はまだ 2 件未達成です");
    await checkbox(page, WALK).check();
    await expect(reminderMessage(page)).toContainText("今日はまだ 1 件未達成です");
    expect(pageErrors, "a missing Badging API reached the page as an uncaught error").toEqual([]);
  });
});

test.describe("Phase 9 — the preference outlives the data", () => {
  test("AC-9.9: it survives a reload, and does not live in the document", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, SEED);

    const before = await readStorage(page);
    await optIn(page);

    expect(await readBadgePreference(page)).toBe("on");
    // The document is the user's habits. A preference about this device's icon is
    // not part of it, and writing one must not rewrite the other.
    expect(await readStorage(page), "opting in rewrote the document").toBe(before);

    await page.reload();
    await expectDashboardReady(page);
    await expect(disableBadgeButton(page)).toBeVisible();
    await expect.poll(() => currentBadge(page)).toBe(2);
  });

  test("AC-9.9: an import does not change the preference", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, SEED);
    await optIn(page);

    // Export the current data, so the file being imported is one the app made.
    const [downloaded] = await Promise.all([
      page.waitForEvent("download"),
      exportButton(page).click(),
    ]);
    const exported = fs.readFileSync(await downloaded.path(), "utf8");

    await fileField(page).setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(exported, "utf8"),
    });
    await confirmImportButton(page).click();
    await expect(habitRow(page, WALK)).toBeVisible();

    // A file describes someone's habits. It cannot describe the notification
    // permission this particular device holds, so it must not touch the setting.
    expect(await readBadgePreference(page)).toBe("on");
    await expect(disableBadgeButton(page)).toBeVisible();
  });

  test("AC-9.9: a reset does not change the preference", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, SEED);
    await optIn(page);

    await openResetButton(page).click();
    await resetAcknowledgement(page).check();
    await runResetButton(page).click();

    await expect(page.getByText("習慣がまだ登録されていません。")).toBeVisible();
    expect(await readBadgePreference(page)).toBe("on");
    await expect(disableBadgeButton(page)).toBeVisible();
    // Nothing left to be behind on, so nothing is said — and the icon is cleared.
    await expect(reminderMessage(page)).toHaveCount(0);
    await expect.poll(() => currentBadge(page)).toBe("clear");
  });
});

test.describe("Phase 9 — a new day", () => {
  test("AC-9.10: the count and the badge follow the date change", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, {
      habits: [{ id: 1, name: WALK, kind: "boolean" }],
      // Done today, so there is nothing to say until the day turns over.
      entries: { 1: byDaysAgo({ 0: 1 }) },
    });
    await optIn(page);

    await expect(reminderMessage(page)).toHaveText("今日の習慣はすべて達成しています。");
    await expect.poll(() => currentBadge(page)).toBe("clear");

    // Tomorrow, with no record yet. `setSystemTime` moves the clock without
    // firing timers; `runFor` then lets the app's one minute check notice.
    await page.clock.setSystemTime(new Date("2026-03-16T09:00:00"));
    await page.clock.runFor(60_000);

    await expect(reminderMessage(page)).toContainText("今日はまだ 1 件未達成です");
    await expect.poll(() => currentBadge(page)).toBe(1);
  });
});

test.describe("Phase 9 — an unreadable document", () => {
  test("AC-9.11: no reminder is shown, and the backup panel is still in reach", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await stubBadge(page);
    await seedRaw(page, "{ this is not json");

    // The recovery route of AC-8.12 comes first and is unaffected.
    await expect(backupHeading(page)).toBeVisible();
    await expect(page.getByTestId("recovery-notice")).toBeVisible();

    // A count of what is undone over data we could not load would be a fiction.
    await expect(remindersSection(page)).toHaveCount(0);
    await expect(reminderMessage(page)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("Phase 9 — 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("AC-9.12: the reminder and the badge button fit the screen", async ({ page }) => {
    await stubBadge(page);
    await openDashboard(page, SEED);

    await expectWithinViewportWidth(page, remindersSection(page), "the reminder card");
    await expectWithinViewportWidth(page, reminderMessage(page), "the reminder sentence");
    await expectWithinViewportWidth(page, enableBadgeButton(page), "the badge button");

    await optIn(page);
    await expectWithinViewportWidth(page, disableBadgeButton(page), "the badge off button");

    const scrollsSideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(scrollsSideways, "the page scrolls sideways at 375px").toBe(false);
  });
});
