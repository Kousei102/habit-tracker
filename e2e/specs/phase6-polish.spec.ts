import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "@playwright/test";
import { CREDENTIALS, TODAY, daysAgo, expect, expectDashboardReady, loginAs, test } from "../fixtures.ts";
import { E2E_DB_PATH } from "../playwright.config.ts";

// Phase 6 acceptance criteria under test here:
//
//   AC-6.1        `npm run build` then `node server/src/index.ts` alone serves the
//                 client and the app is usable from a browser.
//   AC-6.2 [E2E]  Every Phase 1–5 spec passes against the production build.
//   AC-6.3        A clean clone can be started by following the README.
//   AC-6.4 [E2E]  When the API fails, the screen says so — nothing fails silently.
//   AC-6.5 [E2E]  375 / 768 / 1280px all lay out without breaking and keep the
//                 main operations reachable.
//   AC-6.6        `.env.example` documents every environment variable.
//
// AC-6.2 is not a test in this file: it is the other five spec files, which the
// harness already runs against `npm run e2e:serve` (build + the Node server, no
// Vite). Adding a copy of them here would report the same fact twice.
//
// AC-6.1 is checked from the browser below *and* structurally: the whole suite,
// this file included, only ever talks to the single server process that
// `e2e/playwright.config.ts` starts with `npm run e2e:serve`.
//
// AC-6.3 and AC-6.6 are about files rather than pixels, so they are asserted
// against the repository itself — a README that names a script which does not
// exist, or a variable the code reads and the example file never mentions, is
// exactly the drift those criteria exist to catch. (Running `npm install` in a
// pristine clone is verified outside Playwright; see the review note.)
//
// The clock is pinned to 2026-03-15 by the shared fixture. One test deliberately
// moves it — across midnight — and asserts the screen follows; everything else
// treats "today" as the constant it is.

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DB_FILE = path.resolve(REPO_ROOT, E2E_DB_PATH);

// ---------------------------------------------------------------------------
// Screen vocabulary — role and accessible name only.
// ---------------------------------------------------------------------------

const habitList = (page: Page) => page.getByRole("list", { name: "習慣一覧" });
const habitRow = (page: Page, name: string) => habitList(page).getByRole("listitem").filter({ hasText: name });
const checkbox = (page: Page, name: string) => page.getByRole("checkbox", { name });
const amountField = (page: Page, name: string) => page.getByRole("spinbutton", { name });
const editButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} を編集` });
const deleteButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} を削除` });
const undoButton = (page: Page) => page.getByRole("button", { name: "削除を取り消す" });

const nameField = (page: Page) => page.getByLabel("習慣名");
const targetField = (page: Page) => page.getByLabel("目標値");
const unitField = (page: Page) => page.getByLabel("単位");
const kindOption = (page: Page, label: "チェック式" | "数値式") => page.getByRole("radio", { name: label });
const addButton = (page: Page) => page.getByRole("button", { name: "追加" });

const logoutButton = (page: Page) => page.getByRole("button", { name: "ログアウト" });
const loginHeading = (page: Page) => page.getByRole("heading", { name: "ログイン" });
const loginButton = (page: Page) => page.getByRole("button", { name: "ログイン" });

const heatmapGrid = (page: Page) => page.getByRole("grid", { name: /年間ヒートマップ/ });
const heatmapPicker = (page: Page) => page.getByLabel("表示する習慣");
/** The picker's "everything at once" choice, as it is written on screen. */
const OVERALL_OPTION = "全体";
const cellFor = (page: Page, date: string) => page.getByRole("gridcell", { name: date });

/**
 * The error messages on screen, addressed by role.
 *
 * `getByRole("alert")` on its own is a strict-mode violation the moment two
 * panels fail at once — which is the normal case when the API is down, and is
 * behaviour Phase 3–5 already accepted. So every assertion here narrows to the
 * message it is actually about.
 */
const alertWith = (page: Page, text: string | RegExp) => page.getByRole("alert").filter({ hasText: text });

/** Statistics panel's "as of" line, which is the day the numbers were asked for. */
const statsAsOf = (page: Page) => page.getByText(/^\d{4}-\d{2}-\d{2} 時点$/);

// ---------------------------------------------------------------------------
// Seeding, through the same API the UI uses.
// ---------------------------------------------------------------------------

type HabitInput = { name: string; kind: "boolean" | "numeric"; target?: number | null; unit?: string };

async function createHabitViaApi(page: Page, input: HabitInput): Promise<number> {
  const response = await page.request.post("/api/habits", { data: input });
  expect(response.status(), `POST /api/habits ${input.name}: ${await response.text()}`).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

function readEntries(habitId: number): Array<{ date: string; value: number }> {
  const db = new DatabaseSync(DB_FILE);
  try {
    return db
      .prepare("SELECT date, value FROM entries WHERE habit_id = ? ORDER BY date")
      .all(habitId) as unknown as Array<{ date: string; value: number }>;
  } finally {
    db.close();
  }
}

/** A habit belonging to somebody else, created straight in the database. */
function seedForeignHabit(name: string, archived: boolean): number {
  const db = new DatabaseSync(DB_FILE);
  try {
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

    return Number(
      db
        .prepare(
          `INSERT INTO habits (user_id, name, kind, target, unit, color, sort_order, archived_at, created_at)
           VALUES (?, ?, 'boolean', NULL, NULL, 'blue', 0, ?, ?)`,
        )
        .run(userId, name, archived ? now : null, now).lastInsertRowid,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------

test.describe("Phase 6 — polish", () => {
  // -------------------------------------------------------------------------
  // AC-6.1: one process serves both the API and the built client.
  // -------------------------------------------------------------------------

  test("AC-6.1: the built client is served by the API process itself, and the app works", async ({ page }) => {
    const health = await page.request.get("/api/health");
    expect(health.status()).toBe(200);
    const apiOrigin = new URL(health.url()).origin;

    // Collect what the document pulled in, so "served by the same process" is
    // read off the wire rather than assumed.
    const assetUrls: string[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/")) return;
      assetUrls.push(response.url());
    });

    const document = await page.goto("/");
    expect(document?.status()).toBe(200);
    expect(document?.headers()["content-type"] ?? "").toMatch(/text\/html/);
    expect(new URL(document?.url() ?? "").origin).toBe(apiOrigin);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(loginHeading(page)).toBeVisible();

    // The bundle came from the same origin as the API — no second server.
    const scripts = await page.locator("script[src]").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLScriptElement).src),
    );
    expect(scripts.length, "the page loads a built bundle").toBeGreaterThan(0);
    for (const src of scripts) expect(new URL(src).origin).toBe(apiOrigin);

    // A Vite dev server would have injected its own client; a production build
    // must not need one.
    expect(scripts.join(" ")).not.toContain("/@vite/");
    expect(assetUrls.join(" ")).not.toContain("/@vite/");
    expect(assetUrls.join(" ")).not.toContain("/node_modules/.vite");

    // The asset really is served (a 404 bundle would still leave the page blank).
    const bundle = await page.request.get(scripts[0] as string);
    expect(bundle.status()).toBe(200);
    expect(bundle.headers()["content-type"] ?? "").toMatch(/javascript/);

    // ...and end to end: sign in, record something and see every panel answer —
    // all from this one origin, with no dev server anywhere.
    await loginAs(page);
    const name = "P6_本番配信_確認";
    await nameField(page).fill(name);
    await kindOption(page, "チェック式").check();
    await addButton(page).click();

    const row = habitRow(page, name);
    await expect(row).toBeVisible();
    await checkbox(page, name).check();
    await expect(row.getByText("達成", { exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "習慣の統計" })).toBeVisible();
    await expect(heatmapGrid(page)).toBeVisible();

    await page.reload();
    await expectDashboardReady(page);
    await expect(checkbox(page, name)).toBeChecked();
  });

  test("AC-6.1: a client-side path still returns the app, a missing asset still 404s", async ({ page }) => {
    // A reload on a sub-path must not 404 (SPA fallback), and a missing asset
    // must not be answered with HTML — that turns into a MIME error with no
    // explanation in the UI.
    const deep = await page.request.get("/some/deep/route");
    expect(deep.status()).toBe(200);
    expect(deep.headers()["content-type"] ?? "").toMatch(/text\/html/);

    const missing = await page.request.get("/assets/definitely-not-here.js");
    expect(missing.status()).toBe(404);
    expect(missing.headers()["content-type"] ?? "").not.toMatch(/text\/html/);
  });

  // -------------------------------------------------------------------------
  // AC-6.3 / AC-6.6: the documentation matches the code.
  // -------------------------------------------------------------------------

  test("AC-6.3: every npm script the README tells the user to run exists", async () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    const referenced = new Set<string>();
    for (const match of readme.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) {
      referenced.add(match[1] as string);
    }
    // `npm start` / `npm test` are the shorthand forms.
    for (const match of readme.matchAll(/\bnpm (start|test)\b/g)) referenced.add(match[1] as string);

    expect(referenced.size, "the README names some commands").toBeGreaterThan(3);
    for (const script of referenced) {
      expect(Object.keys(manifest.scripts), `README says \`npm run ${script}\``).toContain(script);
    }

    // The setup section has to name the four steps a clean clone needs; a README
    // that dropped `seed-user` leaves the user with no account and no clue.
    for (const step of ["npm install", ".env.example", "npm run seed-user", "npm run dev"]) {
      expect(readme, `README is missing the setup step ${step}`).toContain(step);
    }
  });

  test("AC-6.6: every environment variable the code reads is documented in .env.example", async () => {
    const envExample = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");

    const sources = [
      "server/src/config.ts",
      "server/scripts/seed-user.ts",
      "client/vite.config.ts",
      "server/src/index.ts",
      "server/src/db.ts",
      "server/src/app.ts",
    ];

    const read = new Set<string>();
    for (const relative of sources) {
      const text = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
      for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(match[1] as string);
      for (const match of text.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g)) read.add(match[1] as string);
    }
    // seed-user reads its two through a helper, by name.
    read.add("ADMIN_USER");
    read.add("ADMIN_PASSWORD");

    expect(read.size, "some variables were found").toBeGreaterThan(3);
    for (const name of read) {
      expect(envExample, `.env.example never mentions ${name}`).toContain(name);
    }

    // The two without which nothing works must be present as assignments, not
    // merely mentioned in prose — the file is meant to be copied and used.
    expect(envExample).toMatch(/^ADMIN_USER=/m);
    expect(envExample).toMatch(/^ADMIN_PASSWORD=/m);
  });

  // -------------------------------------------------------------------------
  // AC-6.4: nothing fails silently.
  //
  // Every panel that can load can also fail, and every write the user makes can
  // be refused. Each path below is forced and the screen is then required to
  // carry a message a person can read — located by role, so a message painted
  // into a div nobody announces does not count.
  // -------------------------------------------------------------------------

  test("AC-6.4: a session check that fails is explained instead of looking like a sign-out", async ({ page }) => {
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "内部エラー" }) }),
    );

    await page.goto("/");

    // The login form is the right screen, but the user must be told why they
    // are looking at it — otherwise a broken API is indistinguishable from a
    // password that stopped working.
    await expect(loginHeading(page)).toBeVisible();
    const alert = alertWith(page, /内部エラー|確認できませんでした|サーバー/);
    await expect(alert).toBeVisible();
    await expect(alert).not.toHaveText(/^\s*$/);
  });

  test("AC-6.4: a login that fails for a server reason says so, and says something different from a wrong password", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(loginHeading(page)).toBeVisible();

    // First: a wrong password, unrouted. This is the baseline the server error
    // below has to differ from.
    await page.getByLabel("ユーザー名").fill(CREDENTIALS.username);
    await page.getByLabel("パスワード").fill("definitely-wrong");
    await loginButton(page).click();
    const wrongPassword = await page.getByRole("alert").first().innerText();
    expect(wrongPassword.trim()).not.toBe("");

    // Then: the server is broken rather than the password.
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({ status: 503, contentType: "text/html", body: "<html><body>Bad Gateway</body></html>" }),
    );
    await page.getByLabel("パスワード").fill(CREDENTIALS.password);
    await loginButton(page).click();

    const alert = page.getByRole("alert").first();
    await expect(alert).toBeVisible();
    const serverDown = await alert.innerText();
    expect(serverDown).toContain("503");
    // A proxy's HTML must never reach the screen raw.
    expect(serverDown).not.toContain("<");
    expect(serverDown).not.toContain("Bad Gateway");
    expect(serverDown.trim()).not.toBe(wrongPassword.trim());

    // And still on the login screen: nothing pretended to succeed.
    await expect(loginHeading(page)).toBeVisible();
  });

  test("AC-6.4: an unreachable API is reported, not swallowed", async ({ page }) => {
    await page.route("**/api/**", (route) => route.abort("connectionrefused"));

    await page.goto("/");

    await expect(loginHeading(page)).toBeVisible();
    const alert = alertWith(page, /接続/);
    await expect(alert).toBeVisible();
    // The wording is for a person, not a stack trace.
    await expect(alert).not.toHaveText(/Failed to fetch|TypeError|NetworkError/);
  });

  test("AC-6.4: each panel that cannot load says so in its own words", async ({ page }) => {
    await page.route("**/api/habits**", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "壊れた" }) })
        : route.fallback(),
    );
    await page.route("**/api/stats**", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "壊れた" }) }),
    );
    await page.route("**/api/entries**", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "壊れた" }) })
        : route.fallback(),
    );

    await loginAs(page);

    // Three separate panels, three separate messages — and every one of them a
    // live region, so a reader is told rather than left with a blank card.
    await expect(alertWith(page, "習慣を読み込めませんでした")).toBeVisible();
    await expect(alertWith(page, "統計を読み込めませんでした")).toBeVisible();
    await expect(alertWith(page, "記録を読み込めませんでした")).toBeVisible();

    // Not a spinner that never ends.
    await expect(page.getByText("読み込み中…")).toHaveCount(0);
  });

  test("AC-6.4: a 200 that is not JSON is reported rather than rendered as emptiness", async ({ page }) => {
    // The SPA fallback answering an API path is the realistic version of this:
    // status 200, body HTML. Treating it as data leaves an empty panel and no
    // explanation anywhere.
    await page.route("**/api/stats**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html></html>" }),
    );

    await loginAs(page);

    const alert = alertWith(page, "統計を読み込めませんでした");
    await expect(alert).toBeVisible();
    await expect(alert).not.toHaveText(/doctype|<html/i);
  });

  test("AC-6.4: a debounced numeric save that fails reports — with no blur and no reload", async ({ page }) => {
    const name = "P6_無言失敗_腹筋";
    const id = await seedHabit(page, { name, kind: "numeric", target: 50, unit: "回" });

    await openDashboard(page);
    const row = habitRow(page, name);
    await expect(row).toBeVisible();

    // Only the debounce timer will send this write: nothing below blurs the
    // field, navigates, or reloads. That is the path most likely to fail in
    // silence, because the user never performed an action to attach an error to.
    await page.route("**/api/entries/**", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "保存に失敗しました" }),
          })
        : route.fallback(),
    );

    const field = amountField(page, name);
    await field.click();
    await field.fill("");
    await field.pressSequentially("42", { delay: 40 });

    // The row itself carries the failure, next to the number that did not save.
    const alert = row.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/保存/);

    // The field still has focus — the report did not depend on leaving it.
    await expect(field).toBeFocused();

    // And nothing was written, so the message is not a lie in the other direction.
    expect(readEntries(id)).toHaveLength(0);
  });

  test("AC-6.4: a failed create, delete and logout are all reported on screen", async ({ page }) => {
    const name = "P6_失敗_作成";
    await loginAs(page);

    // Create.
    await page.route("**/api/habits", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "作成不可" }) })
        : route.fallback(),
    );
    await nameField(page).fill(name);
    await addButton(page).click();
    await expect(alertWith(page, "作成不可")).toBeVisible();
    await expect(habitRow(page, name)).toHaveCount(0);
    await page.unroute("**/api/habits");

    // Delete.
    const victim = "P6_失敗_削除";
    await nameField(page).fill(victim);
    await addButton(page).click();
    await expect(habitRow(page, victim)).toBeVisible();

    await page.route("**/api/habits/*", (route) =>
      route.request().method() === "DELETE"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "削除不可" }) })
        : route.fallback(),
    );
    await deleteButton(page, victim).click();
    await expect(alertWith(page, "削除不可")).toBeVisible();
    // The row is still there: the screen did not act as if the delete happened.
    await expect(habitRow(page, victim)).toBeVisible();
    await page.unroute("**/api/habits/*");

    // Logout.
    await page.route("**/api/auth/logout", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "終了不可" }) }),
    );
    await logoutButton(page).click();
    await expect(alertWith(page, "終了不可")).toBeVisible();
    // Still signed in — dropping to the login screen here would be a lie the
    // next reload contradicts, because the session is still valid.
    await expect(logoutButton(page)).toBeVisible();
    await page.unroute("**/api/auth/logout");
  });

  test("AC-2.8 regression: a logout that succeeds still returns to the login screen and stays there", async ({
    page,
  }) => {
    await loginAs(page);

    await logoutButton(page).click();
    await expect(loginHeading(page)).toBeVisible();

    await page.reload();
    await expect(loginHeading(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "ダッシュボード" })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // AC-6.5: three widths.
  // -------------------------------------------------------------------------

  for (const width of [375, 768, 1280]) {
    test(`AC-6.5: at ${width}px the layout holds and the main operations work`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openDashboard(page);

      // Every control a user needs is inside the viewport's width and can be
      // clicked. Vertical position is not asserted: a page taller than the
      // window is normal, and Playwright scrolls to the target exactly as a
      // user would. What must not happen is a control that is off to the side,
      // or covered, or disabled.
      const name = `P6_幅${width}_散歩`;

      await nameField(page).scrollIntoViewIfNeeded();
      await expectWithinViewportWidth(page, nameField(page), "習慣名");
      await nameField(page).fill(name);

      await kindOption(page, "チェック式").check();
      await expectWithinViewportWidth(page, addButton(page), "追加");
      await addButton(page).click();

      const row = habitRow(page, name);
      await expect(row).toBeVisible();
      await expectWithinViewportWidth(page, row, "習慣の行");

      // With a habit on screen every panel is drawn, including the widest thing
      // on the page. Nothing sticks out sideways: the page itself never scrolls
      // horizontally, whatever the heatmap's own container does.
      await expect(heatmapGrid(page)).toBeVisible();
      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth - document.body.clientWidth,
        root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(overflow.body, "document.body scrolls sideways").toBeLessThanOrEqual(1);
      expect(overflow.root, "documentElement scrolls sideways").toBeLessThanOrEqual(1);

      // Record it, edit it, delete it, undo the delete — the whole set of
      // primary operations, at this width.
      await checkbox(page, name).check();
      await expect(row.getByText("達成", { exact: true })).toBeVisible();

      await editButton(page, name).click();
      await expect(page.getByRole("heading", { name: "習慣を編集" })).toBeVisible();
      await page.getByRole("button", { name: "キャンセル" }).click();

      await expectWithinViewportWidth(page, heatmapPicker(page), "表示する習慣");
      await heatmapPicker(page).selectOption({ label: name });
      await expect(page.getByRole("grid", { name: `${name} の年間ヒートマップ` })).toBeVisible();

      await deleteButton(page, name).click();
      await expect(habitRow(page, name)).toHaveCount(0);
      await expectWithinViewportWidth(page, undoButton(page), "削除を取り消す");
      await undoButton(page).click();
      await expect(habitRow(page, name)).toBeVisible();

      await expectWithinViewportWidth(page, logoutButton(page), "ログアウト");
      await expect(logoutButton(page)).toBeEnabled();

      // Tidy up so the next width starts from the same list.
      await deleteButton(page, name).click();
      await expect(habitRow(page, name)).toHaveCount(0);
    });
  }

  /**
   * A habit whose name is long enough to be ordinary and short enough to be
   * unremarkable.
   *
   * 19 characters, against a form that accepts 60 (`maxLength` in
   * HabitForm.tsx), so this is well inside what the product invites a user to
   * type. The name matters because the heatmap's `<select>` takes its width
   * from its widest option.
   */
  const ORDINARY_LONG_NAME = "毎朝のストレッチと深呼吸をきちんとやる";

  /**
   * The widest content the product itself accepts.
   *
   * Not invented numbers: `server/src/routes/habits.ts` caps a name at 60
   * characters, a unit at 12 and a target at 1,000,000, and
   * `server/src/routes/entries.ts` caps a value at the same 1,000,000. A layout
   * that only holds for short names is a layout that breaks on data the server
   * will happily store — which is how the 375px page scroll got past Phase 5 in
   * the first place: its specs never used a long name.
   */
  const MAX_NAME = "習".repeat(60);
  const MAX_UNIT = "ペ".repeat(12);
  const MAX_NUMBER = 1_000_000;
  const DELETED_NAME = "跡".repeat(40);

  /**
   * Everything about the page's horizontal extent, in one look.
   *
   * `.heatmap__scroll` is the one container allowed to scroll sideways
   * (AC-5.5), so it and everything inside it is excluded — the SVG is
   * deliberately wider than the screen. Anything else that either scrolls
   * internally or draws past the right edge is reported by name, because
   * "30px too wide" on its own is not something anybody can act on.
   */
  async function measureWidths(page: Page, viewport: number) {
    return page.evaluate((width) => {
      const SCROLLER = ".heatmap__scroll";
      const insideScroller = (element: Element) => element.closest(SCROLLER) !== null;
      const describe = (element: Element) =>
        `${element.tagName.toLowerCase()}.${String((element as HTMLElement).className)}`;

      // A text-ish form control scrolling its own value is how every browser has
      // always drawn one; it is not the page's layout coming apart. What matters
      // for such a control is asserted directly instead: it stays on screen, it
      // stays operable, and its value is legible elsewhere on the row.
      const OWNS_ITS_SCROLL = new Set(["INPUT", "TEXTAREA", "SELECT"]);

      const scrollingInside: string[] = [];
      const pastRightEdge: string[] = [];

      for (const element of Array.from(document.querySelectorAll("body *"))) {
        if (insideScroller(element)) continue;

        const style = getComputedStyle(element);
        const scrollable =
          style.overflowX === "auto" || style.overflowX === "scroll" || OWNS_ITS_SCROLL.has(element.tagName);
        if (!scrollable && element.scrollWidth - element.clientWidth > 1) {
          scrollingInside.push(`${describe(element)} sw=${element.scrollWidth} cw=${element.clientWidth}`);
        }

        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.right > width + 1) {
          pastRightEdge.push(`${describe(element)}@${Math.round(rect.right)}`);
        }
      }

      return {
        body: document.body.scrollWidth - document.body.clientWidth,
        root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollingInside,
        pastRightEdge,
      };
    }, viewport);
  }

  test("AC-6.5: even the widest content the product accepts does not scroll the page", async ({ page }) => {
    // A numeric habit at every server limit at once, with today already at the
    // maximum value: "1000000 / 1000000 ペペペペペペペペペペペペ".
    const widest = await seedHabit(page, {
      name: MAX_NAME,
      kind: "numeric",
      target: MAX_NUMBER,
      unit: MAX_UNIT,
    });
    expect(
      (await page.request.put(`/api/entries/${widest}/${TODAY}`, { data: { value: MAX_NUMBER } })).status(),
    ).toBe(200);

    // ...and a deleted habit with a record, so the picker also carries a
    // 「（削除済み）」 option — the suffix Phase 6 added on top of the name.
    const deleted = await seedHabit(page, { name: DELETED_NAME, kind: "boolean" });
    expect((await page.request.put(`/api/entries/${deleted}/${TODAY}`, { data: { value: 1 } })).status()).toBe(200);
    expect((await page.request.delete(`/api/habits/${deleted}`)).status()).toBe(200);

    try {
      await openDashboard(page);
      await expect(heatmapGrid(page)).toBeVisible();

      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(heatmapGrid(page)).toBeVisible();

        // Each of the three kinds of view the picker can be in: the overall
        // map, an active habit's own, and a deleted habit's own. They render
        // different labels, and the label is what sizes the control.
        for (const option of [OVERALL_OPTION, MAX_NAME, `${DELETED_NAME}（削除済み）`]) {
          await heatmapPicker(page).selectOption({ label: option });
          await expect(page.getByRole("grid", { name: `${option} の年間ヒートマップ` })).toBeVisible();

          const measured = await measureWidths(page, width);
          const where = `${width}px / ${option.slice(0, 12)}…`;

          expect(measured.body, `document.body scrolls sideways at ${where}: ${JSON.stringify(measured)}`)
            .toBeLessThanOrEqual(1);
          expect(measured.root, `documentElement scrolls sideways at ${where}`).toBeLessThanOrEqual(1);
          expect(measured.pastRightEdge, `elements drawn past the right edge at ${where}`).toEqual([]);
          expect(measured.scrollingInside, `elements scrolling internally at ${where}`).toEqual([]);

          // The picker is a control, so it has to be on the screen — not merely
          // reachable by dragging the page sideways.
          await expectWithinViewportWidth(page, heatmapPicker(page), `表示する習慣 at ${where}`);
        }
      }

      // The number box does scroll its own value at 375px (a seven-digit number
      // in a 5.5rem field). That is the browser drawing an <input>, not the page
      // breaking — so what is asserted is what a user would actually notice:
      await page.setViewportSize({ width: 375, height: 800 });
      const row = habitRow(page, MAX_NAME);
      const field = amountField(page, MAX_NAME);

      // ...the field is wholly on screen,
      await expectWithinViewportWidth(page, field, "数値入力欄 at 375px");
      // ...the value is legible in full right beside it, whatever the box shows,
      await expect(row).toContainText(`${MAX_NUMBER} / ${MAX_NUMBER} ${MAX_UNIT}`);
      // ...and it still takes input and saves it.
      await field.fill("12");
      await expect(row).toContainText(`12 / ${MAX_NUMBER} ${MAX_UNIT}`);
      await page.reload();
      await expectDashboardReady(page);
      await expect(amountField(page, MAX_NAME)).toHaveValue("12");
    } finally {
      await page.request.delete(`/api/habits/${widest}`);
    }
  });

  test("AC-6.5: an ordinary long habit name does not scroll the page either", async ({ page }) => {
    // The case that actually regressed: 19 characters, nothing exotic. Kept as
    // its own test so a fix that only handles the extreme case is still caught.
    const id = await seedHabit(page, { name: ORDINARY_LONG_NAME, kind: "boolean" });

    try {
      await openDashboard(page);
      await expect(heatmapGrid(page)).toBeVisible();

      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(heatmapGrid(page)).toBeVisible();

        const measured = await measureWidths(page, width);
        expect(measured.body, `document.body scrolls sideways at ${width}px: ${JSON.stringify(measured)}`)
          .toBeLessThanOrEqual(1);
        expect(measured.root, `documentElement scrolls sideways at ${width}px`).toBeLessThanOrEqual(1);
        expect(measured.pastRightEdge, `elements drawn past the right edge at ${width}px`).toEqual([]);

        await expectWithinViewportWidth(page, heatmapPicker(page), `表示する習慣 at ${width}px`);
      }
    } finally {
      await page.request.delete(`/api/habits/${id}`);
    }
  });

  // -------------------------------------------------------------------------
  // The fix for the above removed `white-space: nowrap` from the progress line
  // and narrowed the picker. Both touch things earlier ACs are about, so both
  // are re-read here from the screen.
  // -------------------------------------------------------------------------

  test("AC-3.2 regression: '0 / 30 分' stays on one readable line at every width", async ({ page }) => {
    const name = "P6_進捗行_瞑想";
    const id = await seedHabit(page, { name, kind: "numeric", target: 30, unit: "分" });

    try {
      await openDashboard(page);
      const row = habitRow(page, name);
      await expect(row).toBeVisible();

      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 800 });

        // The AC's own example, character for character.
        const progress = row.getByText("0 / 30 分", { exact: true });
        await expect(progress, `"0 / 30 分" is not on screen at ${width}px`).toBeVisible();

        // ...and on one line. `overflow-wrap: anywhere` replaced a `nowrap`, so
        // "readable" now has to be measured rather than assumed: a box two line
        // boxes tall means the goal was split from the result.
        const lines = await progress.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            height: element.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(style.lineHeight),
            rects: element.getClientRects().length,
            text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
          };
        });

        expect(lines.text, `progress text at ${width}px`).toBe("0 / 30 分");
        expect(
          lines.height,
          `"0 / 30 分" wrapped onto more than one line at ${width}px: ${JSON.stringify(lines)}`,
        ).toBeLessThan(lines.lineHeight * 1.5);
      }

      // AC-3.4's readings, at the narrowest width, still on one line.
      await page.setViewportSize({ width: 375, height: 800 });
      await amountField(page, name).fill("3");
      await expect(row.getByText("3 / 30 分", { exact: true })).toBeVisible();
      await expect(row.getByText("未達成", { exact: true })).toBeVisible();

      await amountField(page, name).fill("30");
      await expect(row.getByText("30 / 30 分", { exact: true })).toBeVisible();
      await expect(row.getByText("達成", { exact: true })).toBeVisible();

      await page.reload();
      await expectDashboardReady(page);
      await expect(habitRow(page, name).getByText("30 / 30 分", { exact: true })).toBeVisible();
      await expect(habitRow(page, name).getByText("達成", { exact: true })).toBeVisible();
    } finally {
      await page.request.delete(`/api/habits/${id}`);
    }
  });

  test("AC-3.2 regression: ordinary progress lines do not wrap at any width", async ({ page }) => {
    // Removing `white-space: nowrap` is the change that could make a habit read
    // "1500 / 2000" on one line and "ページ" on the next. Five shapes of ordinary
    // data — a plain goal, an exceeded goal, four digits, five digits, a decimal
    // with a wordy unit — each asserted to be complete and on a single line.
    const cases = [
      { name: "P6_折返し_瞑想", target: 30, unit: "分", value: 0, reads: "0 / 30 分" },
      { name: "P6_折返し_腕立て", target: 100, unit: "回", value: 120, reads: "120 / 100 回" },
      { name: "P6_折返し_読書", target: 2000, unit: "ページ", value: 1500, reads: "1500 / 2000 ページ" },
      { name: "P6_折返し_歩数", target: 10000, unit: "歩", value: 12345, reads: "12345 / 10000 歩" },
      { name: "P6_折返し_学習", target: 180, unit: "分間の学習", value: 90.5, reads: "90.5 / 180 分間の学習" },
    ] as const;

    const ids: number[] = [];
    for (const item of cases) {
      const id = await seedHabit(page, { name: item.name, kind: "numeric", target: item.target, unit: item.unit });
      ids.push(id);
      if (item.value > 0) {
        expect(
          (await page.request.put(`/api/entries/${id}/${TODAY}`, { data: { value: item.value } })).status(),
        ).toBe(200);
      }
    }

    try {
      await openDashboard(page);

      for (const width of [375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });

        for (const item of cases) {
          const progress = habitRow(page, item.name).getByText(item.reads, { exact: true });
          await expect(progress, `"${item.reads}" is not on screen at ${width}px`).toBeVisible();

          const measured = await progress.evaluate((element) => ({
            height: element.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
          }));
          expect(
            measured.height,
            `"${item.reads}" wrapped at ${width}px: ${JSON.stringify(measured)}`,
          ).toBeLessThan(measured.lineHeight * 1.5);
        }
      }
    } finally {
      for (const id of ids) await page.request.delete(`/api/habits/${id}`);
    }
  });

  test("the picker's accessible name survives the title attribute, and the cells' tooltip is unchanged", async ({
    page,
  }) => {
    // `title` was added so a clipped option can still be read with a pointer.
    // A title does not replace a <label>, but that is the sort of claim worth
    // measuring rather than believing.
    const name = "P6_タイトル属性_確認";
    const id = await seedHabit(page, { name, kind: "boolean" });
    expect((await page.request.put(`/api/entries/${id}/${TODAY}`, { data: { value: 1 } })).status()).toBe(200);

    try {
      await openDashboard(page);
      await expect(heatmapGrid(page)).toBeVisible();

      // Still exactly one control called 表示する習慣, still reachable by label.
      await expect(page.getByRole("combobox", { name: "表示する習慣" })).toHaveCount(1);
      await expect(heatmapPicker(page)).toHaveAccessibleName("表示する習慣");

      await heatmapPicker(page).selectOption({ label: name });
      await expect(heatmapPicker(page)).toHaveAccessibleName("表示する習慣");
      // The title carries the full label, which is the point of adding it.
      await expect(heatmapPicker(page)).toHaveAttribute("title", name);

      // The options are still addressable by their own text.
      await expect(page.getByRole("option", { name })).toHaveCount(1);

      // The heatmap's own tooltip still comes from the cell's accessible name —
      // the cells must not have grown a title of their own, or the browser
      // would draw a second tooltip over the app's.
      const cell = cellFor(page, TODAY);
      await expect(cell).toHaveAccessibleName(`${TODAY} 達成`);
      expect(await cell.getAttribute("title")).toBeNull();

      // Hovering shows the app's own tooltip, and its words are the cell's
      // accessible name — one sentence, one source. (The <rect> holds no text
      // node, so the only element matching this string is the tooltip itself.)
      await cell.hover();
      const tip = page.getByText(`${TODAY} 達成`, { exact: true });
      await expect(tip).toHaveCount(1);
      await expect(tip).toBeVisible();
    } finally {
      await page.request.delete(`/api/habits/${id}`);
    }
  });

  // -------------------------------------------------------------------------
  // "Today" is re-read while the page is open.
  //
  // Not named by an AC, but every date-dependent number on screen is a function
  // of it, and this phase made it mutable. A wrong answer here is silent, which
  // is exactly what AC-6.4 is about.
  // -------------------------------------------------------------------------

  test("crossing midnight moves the whole dashboard to the new day, without a request loop", async ({ page }) => {
    const name = "P6_日跨ぎ";
    await seedHabit(page, { name, kind: "boolean" });

    let statsRequests = 0;
    let habitRequests = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/stats") statsRequests += 1;
      if (url.pathname === "/api/habits" && request.method() === "GET") habitRequests += 1;
    });

    await openDashboard(page);
    await expect(heatmapGrid(page)).toBeVisible();

    await expect(page.getByText(TODAY, { exact: true })).toBeVisible();
    await expect(statsAsOf(page)).toHaveText(`${TODAY} 時点`);
    await expect(heatmapGrid(page)).toHaveAccessibleName(new RegExp(`〜 ${TODAY}`));

    const beforeStats = statsRequests;
    const beforeHabits = habitRequests;

    // 09:00 on the pinned day → 09:00 the next day.
    await page.clock.fastForward("24:00:00");

    const tomorrow = "2026-03-16";
    await expect(page.getByText(tomorrow, { exact: true })).toBeVisible();
    await expect(statsAsOf(page)).toHaveText(`${tomorrow} 時点`);
    await expect(heatmapGrid(page)).toHaveAccessibleName(new RegExp(`〜 ${tomorrow}`));
    // The grid's right-hand edge really is the new day.
    await expect(cellFor(page, tomorrow)).toHaveCount(1);

    // One refresh per changed day, not one per interval tick. The clock fired
    // 1440 of those during the fast-forward, so an unstable dependency would
    // show up here as hundreds of requests.
    expect(statsRequests - beforeStats, "GET /api/stats after the rollover").toBeLessThanOrEqual(3);
    expect(habitRequests - beforeHabits, "GET /api/habits after the rollover").toBeLessThanOrEqual(3);
    expect(statsRequests - beforeStats, "the rollover did refresh the stats").toBeGreaterThanOrEqual(1);

    // Let a few more minutes pass on the same day: nothing further should be asked for.
    const settled = statsRequests;
    await page.clock.fastForward("00:10:00");
    await expect(statsAsOf(page)).toHaveText(`${tomorrow} 時点`);
    expect(statsRequests - settled, "a stable day must not keep refetching").toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Cookie flags follow the connection, not the build (a Phase 6 change that
  // AC-2.3 depends on continuing to hold).
  // -------------------------------------------------------------------------

  test("AC-2.3 regression: the session cookie is HttpOnly + SameSite=Lax, and not Secure over http", async ({
    page,
  }) => {
    const response = await page.request.post("/api/auth/login", { data: CREDENTIALS });
    expect(response.status()).toBe(200);

    const setCookie = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .map((header) => header.value)
      .join("\n");

    expect(setCookie).toContain("session=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // The harness serves plain http. A Secure cookie here would be dropped by
    // the browser and every later request would 401 with nothing saying why.
    expect(setCookie, "Secure over http would be silently discarded").not.toMatch(/;\s*Secure/i);
  });

  test("a proxy that terminates TLS gets a Secure cookie", async ({ page }) => {
    const response = await page.request.post("/api/auth/login", {
      data: CREDENTIALS,
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(response.status()).toBe(200);

    const setCookie = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .map((header) => header.value)
      .join("\n");

    expect(setCookie).toMatch(/;\s*Secure/i);

    // A chain of proxies appends; the client-facing hop is the one that decides.
    const chained = await page.request.post("/api/auth/login", {
      data: CREDENTIALS,
      headers: { "X-Forwarded-Proto": "https, http" },
    });
    expect(
      chained
        .headersArray()
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value)
        .join("\n"),
    ).toMatch(/;\s*Secure/i);
  });

  // -------------------------------------------------------------------------
  // Regressions around the two behaviours Phase 6 added on its own initiative.
  // -------------------------------------------------------------------------

  test("AC-3.2 regression: a numeric habit with a target still reads '0 / 30 分'", async ({ page }) => {
    const name = "P6_目標あり_瞑想";
    await loginAs(page);

    await nameField(page).fill(name);
    await kindOption(page, "数値式").check();
    await targetField(page).fill("30");
    await unitField(page).fill("分");
    await addButton(page).click();

    const row = habitRow(page, name);
    await expect(row).toContainText("0 / 30 分");
    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, name)).toContainText("0 / 30 分");
  });

  test("a numeric habit with no target is readable, and 'any value counts' holds everywhere", async ({ page }) => {
    // Phase 6 allows creating one; nothing in the ACs asks for it, so what is
    // pinned here is that it does not break the readings AC-3.2/3.4/5.4 do ask
    // for: the row, the badge, the streak and the cell must all agree.
    const name = "P6_目標なし_読書";
    await loginAs(page);

    await nameField(page).fill(name);
    await kindOption(page, "数値式").check();
    await unitField(page).fill("ページ");
    await addButton(page).click();

    const row = habitRow(page, name);
    await expect(row).toBeVisible();
    // No goal, so no "x / y" — and nothing left dangling like "0 /  ページ".
    await expect(row).toContainText("0 ページ");
    await expect(row).not.toContainText("/");
    await expect(row.getByText("未達成", { exact: true })).toBeVisible();

    await amountField(page, name).fill("3");
    await expect(row.getByText("達成", { exact: true })).toBeVisible();
    await expect(row).toContainText("3 ページ");

    await page.reload();
    await expectDashboardReady(page);
    await expect(amountField(page, name)).toHaveValue("3");
    await expect(habitRow(page, name).getByText("達成", { exact: true })).toBeVisible();

    // The statistics agree with the badge.
    const statsRow = page.getByRole("list", { name: "習慣の統計" }).getByRole("listitem").filter({ hasText: name });
    await expect(statsRow).toContainText("現在ストリーク 1 日");

    // ...and so does the heatmap cell, which has no ratio to work from.
    await heatmapPicker(page).selectOption({ label: name });
    await expect(page.getByRole("grid", { name: `${name} の年間ヒートマップ` })).toBeVisible();
    await expect(cellFor(page, TODAY)).toHaveAccessibleName(`${TODAY} 3 ページ 達成`);
  });

  test("AC-3.6 regression: delete still removes the habit, and the undo brings it back with its records", async ({
    page,
  }) => {
    const name = "P6_取り消し_腕立て";
    const id = await seedHabit(page, { name, kind: "boolean" });
    const past = daysAgo(3);
    expect((await page.request.put(`/api/entries/${id}/${past}`, { data: { value: 1 } })).status()).toBe(200);

    await openDashboard(page);
    await expect(habitRow(page, name)).toBeVisible();

    await deleteButton(page, name).click();
    // AC-3.6 unchanged: one click, gone from the list, no dialog in the way.
    await expect(habitRow(page, name)).toHaveCount(0);

    await undoButton(page).click();
    await expect(habitRow(page, name)).toBeVisible();

    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, name)).toBeVisible();
    // The history the logical delete kept is still attached to it.
    expect(readEntries(id).map((entry) => entry.date)).toContain(past);
  });

  test("restore is 404 for a habit that is not deleted, is not yours, or does not exist", async ({ page }) => {
    await loginAs(page);

    const mine = await seedHabit(page, { name: "P6_復元_自分の", kind: "boolean" });
    const foreignArchived = seedForeignHabit("P6_復元_他人の削除済み", true);
    const unknownId = 987_654_322;

    const active = await page.request.post(`/api/habits/${mine}/restore`);
    const foreign = await page.request.post(`/api/habits/${foreignArchived}/restore`);
    const unknown = await page.request.post(`/api/habits/${unknownId}/restore`);

    expect(active.status()).toBe(404);
    expect(foreign.status()).toBe(404);
    expect(unknown.status()).toBe(404);
    // Byte-identical: any difference between "someone else's" and "nonexistent"
    // is an existence oracle (the AC-3.7 rule, applied to the new endpoint).
    expect(await foreign.text()).toBe(await unknown.text());
    expect(await active.text()).toBe(await unknown.text());

    // And the other user's habit really is still archived.
    const db = new DatabaseSync(DB_FILE);
    try {
      const row = db.prepare("SELECT archived_at FROM habits WHERE id = ?").get(foreignArchived) as {
        archived_at: string | null;
      };
      expect(row.archived_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("include_archived=1 is still scoped to the signed-in user", async ({ page }) => {
    const foreignActive = seedForeignHabit("P6_他人の有効な習慣", false);
    const foreignArchived = seedForeignHabit("P6_他人の削除済み習慣", true);

    await loginAs(page);

    const response = await page.request.get("/api/habits?include_archived=1");
    expect(response.status()).toBe(200);
    const listed = (await response.json()) as Array<{ id: number; name: string }>;

    expect(listed.map((habit) => habit.id)).not.toContain(foreignActive);
    expect(listed.map((habit) => habit.id)).not.toContain(foreignArchived);
    expect(listed.map((habit) => habit.name)).not.toContain("P6_他人の有効な習慣");
    expect(listed.map((habit) => habit.name)).not.toContain("P6_他人の削除済み習慣");

    // Nor do they reach the screen through the heatmap's picker.
    await expect(heatmapGrid(page)).toBeVisible();
    await expect(page.getByRole("option", { name: /P6_他人の/ })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Small helpers kept below the suite so the tests above read as criteria.
// ---------------------------------------------------------------------------

/**
 * Creates a habit over the API, signing in first if the request context has no
 * session yet — some tests seed before the browser has ever logged in.
 */
async function seedHabit(page: Page, input: HabitInput): Promise<number> {
  // The API context shares the browser's cookie jar, but a request made before
  // any sign-in has none — so this signs in over the API first when needed.
  const probe = await page.request.get("/api/habits");
  if (probe.status() === 401) {
    const login = await page.request.post("/api/auth/login", { data: CREDENTIALS });
    expect(login.status(), await login.text()).toBe(200);
  }
  return createHabitViaApi(page, input);
}

/**
 * Opens the dashboard, whether or not the browser already holds a session.
 *
 * `loginAs` insists on meeting the login form first, which is right for a spec
 * about signing in and wrong for one that seeded over the API: that seeding
 * leaves a session cookie in the shared jar, so `/` goes straight through and
 * the login heading never appears.
 */
async function openDashboard(page: Page): Promise<void> {
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "ログイン" }).or(page.getByRole("heading", { name: "ダッシュボード" }));
  await expect(heading.first()).toBeVisible();

  if (await page.getByRole("heading", { name: "ログイン" }).isVisible()) {
    await page.getByLabel("ユーザー名").fill(CREDENTIALS.username);
    await page.getByLabel("パスワード").fill(CREDENTIALS.password);
    await loginButton(page).click();
  }

  await expectDashboardReady(page);
}

/**
 * Asserts the control sits inside the viewport's width and can be interacted
 * with. Horizontal position is what a narrow screen breaks; vertical position is
 * scrolling, which is not a layout failure.
 */
async function expectWithinViewportWidth(page: Page, locator: Locator, label: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${label} is not visible`).toBeVisible();

  const viewport = page.viewportSize();
  const box = await locator.boundingBox();
  expect(box, `${label} has no box`).not.toBeNull();
  if (box === null || viewport === null) return;

  expect(box.x, `${label} starts left of the viewport`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} extends past ${viewport.width}px`).toBeLessThanOrEqual(viewport.width + 1);
}
