import fs from "node:fs";
import path from "node:path";
import type { Page, Request } from "@playwright/test";
import {
  SCHEMA_VERSION,
  STORAGE_KEY,
  TODAY,
  addButton,
  amountField,
  alertWith,
  byDaysAgo,
  checkbox,
  daysAgo,
  deleteButton,
  documentText,
  expect,
  expectDashboardReady,
  expectHeatmapReady,
  habitList,
  habitRow,
  kindOption,
  nameField,
  open,
  openDashboard,
  readStorage,
  run,
  seedRaw,
  statsRow,
  targetField,
  test,
  unitField,
} from "../fixtures.ts";
import { STATIC_URL } from "../playwright.config.ts";

// Phase 7 acceptance criteria under test here:
//
//   AC-7.1        No server/ directory; workspaces no longer name one; a clean
//                 `npm install` works. (Checked against the repository below and,
//                 for the install itself, outside Playwright — see the review.)
//   AC-7.2        The build is static and needs no Node process. Asserted against
//                 `python3 -m http.server`, not against `vite preview`.
//   AC-7.3 [E2E]  Creating, recording, editing and deleting produces no `/api/`
//                 request at all.
//   AC-7.4 [E2E]  No login screen; `/` is the dashboard.
//   AC-7.5 [单] — the storage layer's synchronous round trip is a unit test
//                 (client/src/data/store.test.ts); what is checked here is the
//                 consequence a user can see: a value is readable back the
//                 instant it is written.
//   AC-7.6 [E2E]  Broken / unknown-version / empty documents neither crash the
//                 screen nor get silently overwritten.
//   AC-7.10 [E2E] A fresh browser context starts empty.
//   AC-7.11 [E2E] 10 habits × 5 years (18,250 records) still renders and survives
//                 a reload.
//   AC-7.12 [E2E] A save that fails is reported, not swallowed.
//
// AC-7.7 / 7.8 / 7.9 / 7.14 are the Phase 3–6 behaviours carried over, and they
// are tested where they were: phase3/4/5/6-*.spec.ts, rewritten to seed
// localStorage instead of a database.

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** Every request the page makes, so "no /api/ anywhere" can be read off the wire. */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request: Request) => urls.push(request.url()));
  return urls;
}

function apiRequests(urls: string[]): string[] {
  return urls.filter((url) => new URL(url).pathname.startsWith("/api"));
}

test.describe("Phase 7 — the server is gone", () => {
  // -------------------------------------------------------------------------
  // AC-7.1 / AC-7.2 — the shape of the repository and of the build.
  // -------------------------------------------------------------------------

  test("AC-7.1: there is no server directory and no server workspace", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "server")), "server/ still exists").toBe(false);

    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      workspaces: string[];
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.workspaces).toEqual(["client"]);
    // A script that starts a server would be a server by another name.
    for (const [name, script] of Object.entries(manifest.scripts)) {
      expect(script, `npm script "${name}" still refers to server/`).not.toContain("server/");
    }
  });

  test("AC-7.2: the build is static — no /api anywhere in what ships", () => {
    const distDir = path.join(REPO_ROOT, "client", "dist");
    expect(fs.existsSync(path.join(distDir, "index.html")), "the build produced no index.html").toBe(true);

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(distDir);

    // Only static assets — nothing that has to be executed by a runtime.
    const extensions = new Set(files.map((file) => path.extname(file)));
    for (const extension of extensions) {
      expect([".html", ".js", ".css", ".svg", ".png", ".ico", ".json", ".webmanifest", ".txt", ".map"]).toContain(
        extension,
      );
    }

    for (const file of files.filter((name) => /\.(js|html|css)$/.test(name))) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, `${path.relative(REPO_ROOT, file)} still mentions an API path`).not.toMatch(/["'`]\/api\//);
    }
  });

  test("AC-7.2: the app works when served by a plain static file server (no Node)", async ({ page }) => {
    const urls = recordRequests(page);

    // 3102 is `python3 -m http.server`: no SPA fallback, no rewrites, no Node.
    await page.goto(`${STATIC_URL}/`);
    await expectDashboardReady(page);

    // ...and it is usable, not merely rendered.
    await nameField(page).fill("静的配信_散歩");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();
    await expect(habitRow(page, "静的配信_散歩")).toBeVisible();
    await checkbox(page, "静的配信_散歩").check();
    await expect(habitRow(page, "静的配信_散歩").getByText("達成", { exact: true })).toBeVisible();

    await page.reload();
    await expectDashboardReady(page);
    await expect(checkbox(page, "静的配信_散歩")).toBeChecked();

    expect(apiRequests(urls), "the statically served app called an API").toEqual([]);
  });

  // -------------------------------------------------------------------------
  // AC-7.3 / AC-7.4
  // -------------------------------------------------------------------------

  test("AC-7.3: a full session of create, record, edit and delete makes no /api request", async ({ page }) => {
    const urls = recordRequests(page);

    await openDashboard(page);

    // Create — one of each kind.
    await nameField(page).fill("無通信_散歩");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();
    await expect(habitRow(page, "無通信_散歩")).toBeVisible();

    await nameField(page).fill("無通信_読書");
    await kindOption(page, "数値式").check();
    await targetField(page).fill("30");
    await unitField(page).fill("分");
    await addButton(page).click();
    await expect(habitRow(page, "無通信_読書")).toBeVisible();

    // Record.
    await checkbox(page, "無通信_散歩").check();
    await amountField(page, "無通信_読書").fill("30");
    await expect(habitRow(page, "無通信_読書")).toContainText("30 / 30 分");

    // Edit.
    await page.getByRole("button", { name: "無通信_読書 を編集" }).click();
    await nameField(page).fill("無通信_多読");
    await targetField(page).fill("60");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(habitRow(page, "無通信_多読")).toContainText("30 / 60 分");

    // Statistics and the heatmap have both been recomputed by now.
    await expect(statsRow(page, "無通信_散歩")).toContainText("現在ストリーク 1 日");
    await expectHeatmapReady(page);

    // Delete, undo, delete.
    await deleteButton(page, "無通信_散歩").click();
    await expect(habitRow(page, "無通信_散歩")).toHaveCount(0);
    await page.getByRole("button", { name: "削除を取り消す" }).click();
    await expect(habitRow(page, "無通信_散歩")).toBeVisible();
    await deleteButton(page, "無通信_散歩").click();
    await expect(habitRow(page, "無通信_散歩")).toHaveCount(0);

    // Reload — the data comes back from the browser, not from a request.
    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, "無通信_多読")).toContainText("30 / 60 分");

    expect(apiRequests(urls), `requests to /api during the whole session`).toEqual([]);

    // Negative control on the recorder itself: it *can* see a request. Without
    // this, an assertion of "no /api requests" would also pass if the listener
    // were never wired up.
    const before = urls.length;
    await page.evaluate(() => fetch("/api/health").catch(() => undefined));
    await expect.poll(() => urls.length).toBeGreaterThan(before);
    expect(apiRequests(urls)).toHaveLength(1);
  });

  test("AC-7.4: / is the dashboard — there is no login screen anywhere", async ({ page }) => {
    await open(page);

    await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "ログイン" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ログイン" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ログアウト" })).toHaveCount(0);
    await expect(page.getByLabel("パスワード")).toHaveCount(0);

    // And it stays that way across a reload: no session to expire into a form.
    await page.reload();
    await expectDashboardReady(page);
    await expect(page.getByRole("heading", { name: "ログイン" })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // AC-7.5, as far as the screen can show it.
  // -------------------------------------------------------------------------

  test("AC-7.5: a write is readable the moment it is made", async ({ page }) => {
    await openDashboard(page);

    await nameField(page).fill("同期保存_水");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();
    await expect(habitRow(page, "同期保存_水")).toBeVisible();

    await checkbox(page, "同期保存_水").check();

    // No wait, no polling: the click handler returned, so the bytes are there.
    const stored = await readStorage(page);
    expect(stored, "nothing was written").not.toBeNull();
    const document = JSON.parse(stored as string) as {
      version: number;
      habits: Array<{ name: string; id: number }>;
      entries: Record<string, Record<string, number>>;
    };
    expect(document.version).toBe(SCHEMA_VERSION);
    expect(document.habits.map((habit) => habit.name)).toContain("同期保存_水");
    const id = document.habits.find((habit) => habit.name === "同期保存_水")?.id as number;
    expect(document.entries[String(id)]?.[TODAY]).toBe(1);

    // There is no "保存中…" state to observe, because there is no moment at
    // which the value is only half saved.
    await expect(page.getByText("保存中")).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // AC-7.6 — the case this phase can do the most damage in.
  //
  // For each unreadable document: the screen must stay up and say something a
  // person can read, and the stored bytes must still be *byte for byte* what
  // they were, even after the user tries to carry on working.
  // -------------------------------------------------------------------------

  const unreadable: Array<{ label: string; text: string }> = [
    { label: "truncated JSON", text: '{"version":1,"habits":[{"id":1,"nam' },
    { label: "not JSON at all", text: "これは JSON ではありません" },
    { label: "a newer schema version", text: documentText({ version: 99, habits: [{ id: 1, name: "散歩", kind: "boolean" }] }) },
    { label: "another app's JSON", text: JSON.stringify({ todos: [{ title: "牛乳を買う", done: false }] }) },
    { label: "a JSON array", text: "[1,2,3]" },
    { label: "a habits list with a broken row", text: '{"version":1,"next_habit_id":2,"habits":[{"id":"one","name":"散歩","kind":"boolean"}],"entries":{}}' },
  ];

  for (const variant of unreadable) {
    test(`AC-7.6: ${variant.label} — the screen survives and the bytes are untouched`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await seedRaw(page, variant.text);

      // The app is still an app: the heading renders and something explains why
      // there is nothing in it.
      await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();
      const alert = page.getByRole("alert").first();
      await expect(alert).toBeVisible();
      const message = await alert.innerText();
      expect(message.trim(), "the failure was reported with an empty message").not.toBe("");
      // A sentence, not an exception. (`JSON` and `SyntaxError` are the two that
      // leak through a naive `String(cause)`.)
      expect(message).not.toContain("SyntaxError");
      expect(message).not.toContain("JSON.parse");

      // Not a spinner that never ends, either.
      await expect(page.getByText("読み込み中…")).toHaveCount(0);

      // Now the part that matters: the user carries on, and nothing they do may
      // overwrite the document that could not be read.
      await nameField(page).fill("壊れた文書の上に作る");
      await kindOption(page, "チェック式").check();
      await addButton(page).click();
      await expect(alertWith(page, /保存|読み取れ|更新/).first()).toBeVisible();

      await page.reload();
      await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();

      expect(await readStorage(page), "the unreadable document was rewritten").toBe(variant.text);
      expect(pageErrors, "an uncaught exception reached the page").toEqual([]);
    });
  }

  test("AC-7.6: an empty string is 'nothing saved yet', and saving from there works", async ({ page }) => {
    await seedRaw(page, "");
    await expectDashboardReady(page);

    // No data existed, so there is nothing to protect and nothing to complain
    // about: the app simply starts empty.
    await expect(page.getByText("習慣がまだ登録されていません。")).toBeVisible();

    await nameField(page).fill("空文字列から_散歩");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();
    await expect(habitRow(page, "空文字列から_散歩")).toBeVisible();

    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, "空文字列から_散歩")).toBeVisible();

    const stored = JSON.parse((await readStorage(page)) as string) as { version: number };
    expect(stored.version).toBe(SCHEMA_VERSION);
  });

  test("AC-7.6: whitespace only behaves the same way", async ({ page }) => {
    await seedRaw(page, "   \n  ");
    await expectDashboardReady(page);
    await expect(page.getByText("習慣がまだ登録されていません。")).toBeVisible();
  });

  test("AC-7.6 control: a readable document is not treated as broken", async ({ page }) => {
    // Without this, every assertion above would also pass against an app that
    // declared *everything* unreadable.
    const text = documentText({
      habits: [{ id: 1, name: "対照_散歩", kind: "boolean" }],
      entries: { 1: byDaysAgo({ 0: 1 }) },
    });
    await seedRaw(page, text);
    await expectDashboardReady(page);

    await expect(habitRow(page, "対照_散歩")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(checkbox(page, "対照_散歩")).toBeChecked();
  });

  // -------------------------------------------------------------------------
  // AC-7.10
  // -------------------------------------------------------------------------

  test("AC-7.10: a new browser context starts empty", async ({ page, browser }) => {
    await openDashboard(page, {
      habits: [{ id: 1, name: "この端末だけの習慣", kind: "boolean" }],
      entries: { 1: byDaysAgo({ 0: 1 }) },
    });
    await expect(habitRow(page, "この端末だけの習慣")).toBeVisible();

    const other = await browser.newContext();
    try {
      const fresh = await other.newPage();
      await fresh.clock.install({ time: new Date("2026-03-15T09:00:00") });
      await fresh.goto("/");
      await expect(fresh.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();

      await expect(fresh.getByText("習慣がまだ登録されていません。")).toBeVisible();
      await expect(
        fresh.getByRole("list", { name: "習慣一覧" }).getByRole("listitem"),
      ).toHaveCount(0);
      expect(await fresh.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    } finally {
      await other.close();
    }

    // ...and the original context still has its data: the two are separate, not
    // both empty.
    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, "この端末だけの習慣")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // AC-7.11
  // -------------------------------------------------------------------------

  test("AC-7.11: ten habits and five years of records render and survive a reload", async ({ page }) => {
    const HABITS = 10;
    const DAYS = 1825; // 5 × 365

    const habits = Array.from({ length: HABITS }, (_, index) => ({
      id: index + 1,
      name: index % 2 === 0 ? `大量_チェック${index}` : `大量_数値${index}`,
      kind: (index % 2 === 0 ? "boolean" : "numeric") as "boolean" | "numeric",
      target: index % 2 === 0 ? null : 30,
      unit: index % 2 === 0 ? null : "分",
    }));

    const entries: Record<number, Record<string, number>> = {};
    let written = 0;
    for (const habit of habits) {
      const days: Record<string, number> = {};
      for (let offset = 0; offset < DAYS; offset += 1) {
        // A mix of achieved and not, so nothing is uniform enough to shortcut.
        days[daysAgo(offset)] = habit.kind === "boolean" ? (offset % 3 === 0 ? 1 : 0) : (offset % 7) * 6;
        written += 1;
      }
      entries[habit.id] = days;
    }
    expect(written, "the seed really is 18,250 records").toBe(18_250);

    const text = documentText({ habits, entries });
    // Well inside the ~5 MB localStorage budget, which is counted in UTF-16 code
    // units — so the number that matters is characters, not bytes.
    expect(text.length, `stored document length: ${text.length}`).toBeLessThan(2_500_000);

    await page.goto("/");
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [STORAGE_KEY, text],
    );

    const started = Date.now();
    await page.reload();
    await expect(habitList(page).getByRole("listitem")).toHaveCount(HABITS);
    const renderMs = Date.now() - started;

    await expectDashboardReady(page);
    await expectHeatmapReady(page);

    // Every panel really did compute, not just the list.
    await expect(statsRow(page, "大量_チェック0")).toContainText(/現在ストリーク \d+ 日/);
    await expect(page.getByRole("gridcell", { name: TODAY })).toHaveCount(1);
    await expect(page.getByRole("gridcell", { name: daysAgo(360) })).toHaveCount(1);

    // A record from five years back is still in the document afterwards.
    const stored = JSON.parse((await readStorage(page)) as string) as {
      entries: Record<string, Record<string, number>>;
    };
    expect(Object.keys(stored.entries["1"] ?? {}).length).toBe(DAYS);
    expect(stored.entries["1"]?.[daysAgo(DAYS - 1)]).toBeDefined();

    // Recording today still works at this size, and survives a reload.
    await checkbox(page, "大量_チェック0").check();
    await page.reload();
    await expectDashboardReady(page);
    await expect(checkbox(page, "大量_チェック0")).toBeChecked();

    // Not a hard performance criterion — the AC only asks that it works — but a
    // number worth having in the report, and a ceiling that a full re-parse per
    // row would blow through.
    expect(renderMs, `first render with 18,250 records took ${renderMs}ms`).toBeLessThan(15_000);
    console.log(`AC-7.11: first render with 18,250 records: ${renderMs}ms`);
  });

  // -------------------------------------------------------------------------
  // AC-7.12
  // -------------------------------------------------------------------------

  /** Makes every write to the app's key fail the way a full browser's does. */
  async function breakWrites(page: Page): Promise<void> {
    await page.addInitScript((key) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, name: string, value: string): void {
        if (name === key) {
          const error = new Error("quota") as Error & { name: string; code: number };
          error.name = "QuotaExceededError";
          error.code = 22;
          throw error;
        }
        original.call(this, name, value);
      };
    }, STORAGE_KEY);
  }

  test("AC-7.12: a habit that cannot be saved says so, and is not shown as created", async ({ page }) => {
    await open(page);
    await breakWrites(page);
    await page.reload();
    await expectDashboardReady(page);

    await nameField(page).fill("容量オーバー_散歩");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();

    const alert = page.getByRole("alert").first();
    await expect(alert).toBeVisible();
    const message = await alert.innerText();
    expect(message).toContain("保存");
    // Not the browser's own words.
    expect(message).not.toContain("QuotaExceededError");
    expect(message).not.toMatch(/[A-Za-z]{5,}/);

    // The list did not pretend otherwise.
    await expect(habitRow(page, "容量オーバー_散歩")).toHaveCount(0);
    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, "容量オーバー_散歩")).toHaveCount(0);
  });

  test("AC-7.12: a record that cannot be saved says so on its own row", async ({ page }) => {
    await open(page, {
      habits: [
        { id: 1, name: "容量_散歩", kind: "boolean" },
        { id: 2, name: "容量_読書", kind: "numeric", target: 30, unit: "分" },
      ],
    });
    await breakWrites(page);
    await page.reload();
    await expectDashboardReady(page);

    const before = await readStorage(page);

    // A checkbox: the write happens on the click. `.click()` and not `.check()`,
    // because the point of this test is that the box does NOT end up ticked —
    // `.check()` would fail on the app behaving correctly.
    await checkbox(page, "容量_散歩").click();
    const rowAlert = habitRow(page, "容量_散歩").getByRole("alert");
    await expect(rowAlert).toBeVisible();
    await expect(rowAlert).toContainText("保存");

    // A number box, which saves behind a 300 ms debounce — the path with no user
    // action to attach an error to, and therefore the one that fails silently if
    // anything does.
    const field = amountField(page, "容量_読書");
    await field.click();
    await field.fill("");
    await field.pressSequentially("42", { delay: 40 });
    const numericAlert = habitRow(page, "容量_読書").getByRole("alert");
    await expect(numericAlert).toBeVisible();
    await expect(numericAlert).toContainText("保存");
    // Reported without the field having to be left.
    await expect(field).toBeFocused();

    // Nothing was written, so the message is not a lie in the other direction.
    expect(await readStorage(page)).toBe(before);

    await page.reload();
    await expectDashboardReady(page);
    await expect(checkbox(page, "容量_散歩")).not.toBeChecked();
    await expect(amountField(page, "容量_読書")).toHaveValue("0");
  });

  test("AC-7.12 control: with storage working, none of that is reported", async ({ page }) => {
    await openDashboard(page, { habits: [{ id: 1, name: "対照_容量_散歩", kind: "boolean" }] });

    await checkbox(page, "対照_容量_散歩").check();
    await expect(habitRow(page, "対照_容量_散歩").getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expectDashboardReady(page);
    await expect(checkbox(page, "対照_容量_散歩")).toBeChecked();
  });

  // -------------------------------------------------------------------------
  // The parse cache in client/src/data/store.ts is not asked for by any AC, so
  // what is pinned here is only that it cannot cost data: a write must be
  // applied to what is *in storage now*, not to what this tab last parsed.
  // -------------------------------------------------------------------------

  test("a document changed by another writer is not clobbered by the next write", async ({ page }) => {
    await openDashboard(page, { habits: [{ id: 1, name: "他タブ_散歩", kind: "boolean" }] });
    await expect(habitRow(page, "他タブ_散歩")).toBeVisible();

    // Another tab (or the same user on another page) adds a habit and a record.
    const updated = documentText({
      habits: [
        { id: 1, name: "他タブ_散歩", kind: "boolean" },
        { id: 2, name: "他タブ_筋トレ", kind: "boolean" },
      ],
      entries: { 2: byDaysAgo({ 1: 1 }) },
      next_habit_id: 3,
    });
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      [STORAGE_KEY, updated],
    );

    // This tab, which never reloaded, now writes.
    await nameField(page).fill("他タブ_ヨガ");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();
    await expect(habitRow(page, "他タブ_ヨガ")).toBeVisible();

    const stored = JSON.parse((await readStorage(page)) as string) as {
      habits: Array<{ id: number; name: string }>;
      entries: Record<string, Record<string, number>>;
    };
    const names = stored.habits.map((habit) => habit.name);
    expect(names, "the other writer's habit was overwritten").toContain("他タブ_筋トレ");
    expect(names).toContain("他タブ_ヨガ");
    // ...and the new habit did not reuse the id the other writer had taken,
    // which would have silently attached that habit's records to this one.
    const yoga = stored.habits.find((habit) => habit.name === "他タブ_ヨガ");
    expect(yoga?.id).not.toBe(2);
    expect(stored.entries["2"]?.[daysAgo(1)]).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Negative controls for the suite itself. If these ever pass, the assertions
  // above are not reaching the screen.
  // -------------------------------------------------------------------------

  test("negative control: a seeded document really does reach the screen", async ({ page }) => {
    await openDashboard(page, {
      habits: [{ id: 1, name: "対照_シード", kind: "numeric", target: 30, unit: "分" }],
      entries: { 1: byDaysAgo(run(0, 4, 30)) },
    });

    await expect(habitRow(page, "対照_シード")).toContainText("30 / 30 分");
    await expect(statsRow(page, "対照_シード")).toContainText("現在ストリーク 5 日");

    // The deliberately wrong expectation the rest of the suite would be worth
    // nothing without: this must be the value that is NOT on screen.
    await expect(statsRow(page, "対照_シード")).not.toContainText("現在ストリーク 4 日");
    await expect(statsRow(page, "対照_シード")).not.toContainText("現在ストリーク 6 日");
    // Not "0 / 30 分": that is a substring of "30 / 30 分" and would be a control
    // that can never fail. This one really is absent from the row.
    await expect(habitRow(page, "対照_シード")).not.toContainText("15 / 30 分");
    await expect(habitRow(page, "対照_シード").getByText("未達成", { exact: true })).toHaveCount(0);
  });
});
