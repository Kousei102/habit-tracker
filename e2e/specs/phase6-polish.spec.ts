import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  TODAY,
  addButton,
  amountField,
  alertWith,
  byDaysAgo,
  cellFor,
  checkbox,
  daysAgo,
  deleteButton,
  documentText,
  editButton,
  expect,
  expectDashboardReady,
  expectHeatmapReady,
  habitRow,
  heatmapGrid,
  heatmapPicker,
  kindOption,
  nameField,
  open,
  openDashboard,
  readStorage,
  seedRaw,
  statsRow,
  targetField,
  test,
  undoButton,
  unitField,
} from "../fixtures.ts";

// Phase 6 acceptance criteria under test here, as they stand after Phase 7:
//
//   AC-6.2 [E2E]  Every earlier spec passes against the production build. That is
//                 the other spec files, which the harness already runs against
//                 `client/dist`; repeating them here would report one fact twice.
//   AC-6.3        A clean clone can be started by following the README.
//   AC-6.4 [E2E]  Nothing fails silently — inherited by AC-7.12.
//   AC-6.5 [E2E]  375 / 768 / 1280px lay out without breaking and keep the main
//                 operations reachable — inherited by AC-7.14.
//
// AC-6.1 and AC-6.6 were retired with the Node server and the environment
// variables it read (docs/phases.md, the ⚠ section). What replaced AC-6.1 —
// "the build runs on a plain static file server" — is AC-7.2 and is tested in
// phase7-local-storage.spec.ts.
//
// The clock is pinned to 2026-03-15 by the shared fixture. One test deliberately
// moves it — across midnight — and asserts the screen follows.

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** Statistics panel's "as of" line, which is the day the numbers were asked for. */
const statsAsOf = (page: Page) => page.getByText(/^\d{4}-\d{2}-\d{2} 時点$/);

/** The picker's "everything at once" choice, as it is written on screen. */
const OVERALL_OPTION = "全体";

test.describe("Phase 6 — polish (AC-7.12 / AC-7.14)", () => {
  // -------------------------------------------------------------------------
  // AC-6.3: the documentation matches the code.
  // -------------------------------------------------------------------------

  test("AC-6.3: every npm script the README tells the user to run exists", () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    const referenced = new Set<string>();
    for (const match of readme.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) referenced.add(match[1] as string);
    for (const match of readme.matchAll(/\bnpm (start|test)\b/g)) referenced.add(match[1] as string);

    expect(referenced.size, "the README names some commands").toBeGreaterThan(3);
    for (const script of referenced) {
      expect(Object.keys(manifest.scripts), `README says \`npm run ${script}\``).toContain(script);
    }

    // The two steps a clean clone needs, now that there is no .env and no user
    // to seed.
    for (const step of ["npm install", "npm run dev"]) {
      expect(readme, `README is missing the setup step ${step}`).toContain(step);
    }

    // ...and it must not still be telling people to run what was deleted.
    expect(readme, "README still mentions seed-user").not.toContain("seed-user");
    expect(readme, "README still points at server/src").not.toContain("server/src");
  });

  test("AC-6.3: the README says where the data actually lives", () => {
    // Not cosmetic: with no server there is no backup, and a user who does not
    // know the records are in this browser will lose them without ever being
    // told they could.
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("localStorage");
    expect(readme).toContain("habit-tracker");
  });

  // -------------------------------------------------------------------------
  // AC-6.4 / AC-7.12: nothing fails silently.
  //
  // The failures that remain after Phase 7 are local: storage that is full,
  // storage that is blocked, and a document that cannot be read. Each is forced
  // and the screen is then required to carry a message a person can read —
  // located by role, so a message painted into a div nobody announces does not
  // count.
  // -------------------------------------------------------------------------

  test("AC-6.4: storage that refuses to work at all is explained, not blank", async ({ page }) => {
    await page.goto("/");
    await page.addInitScript(() => {
      // A browser configured to block site data: reading throws rather than
      // returning null.
      const blocked = {
        getItem() {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
        setItem() {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
        removeItem() {},
        clear() {},
        key: () => null,
        length: 0,
      };
      Object.defineProperty(window, "localStorage", { configurable: true, get: () => blocked });
    });
    await page.reload();

    await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();
    const alert = page.getByRole("alert").first();
    await expect(alert).toBeVisible();
    const message = await alert.innerText();
    expect(message.trim()).not.toBe("");
    // The wording is for a person, not a stack trace.
    expect(message).not.toContain("SecurityError");
    expect(message).not.toContain("DOMException");

    // Not a spinner that never ends.
    await expect(page.getByText("読み込み中…")).toHaveCount(0);
  });

  test("AC-6.4: each panel that cannot load says so in its own words", async ({ page }) => {
    // One unreadable document breaks all three reads at once. Every panel has to
    // account for itself rather than leaving a blank card.
    await seedRaw(page, "{ broken");

    await expect(alertWith(page, "習慣を読み込めませんでした")).toBeVisible();
    await expect(alertWith(page, "統計を読み込めませんでした")).toBeVisible();
    await expect(alertWith(page, "記録を読み込めませんでした")).toBeVisible();
    await expect(page.getByText("読み込み中…")).toHaveCount(0);
  });

  test("AC-6.4: a rejected value is reported beside the field, and nothing is created", async ({ page }) => {
    await openDashboard(page);

    await nameField(page).fill("P6_不正な目標");
    await kindOption(page, "数値式").check();
    // 0 rather than a negative number on purpose: `min="0"` means the browser's
    // own constraint validation would block a negative before the app ever saw
    // it, and this test is about the app's message, not the browser's bubble.
    await targetField(page).fill("0");
    await addButton(page).click();

    const alert = page.getByRole("alert").first();
    await expect(alert).toBeVisible();
    await expect(alert).not.toHaveText(/^\s*$/);
    await expect(habitRow(page, "P6_不正な目標")).toHaveCount(0);

    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, "P6_不正な目標")).toHaveCount(0);
  });

  test("AC-6.4 control: a successful save reports nothing", async ({ page }) => {
    await openDashboard(page);

    await nameField(page).fill("P6_正常系");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();

    await expect(habitRow(page, "P6_正常系")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // AC-6.5 / AC-7.14: three widths.
  // -------------------------------------------------------------------------

  for (const width of [375, 768, 1280]) {
    test(`AC-6.5/AC-7.14: at ${width}px the layout holds and the main operations work`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openDashboard(page);

      // Every control a user needs is inside the viewport's width and can be
      // clicked. Vertical position is not asserted: a page taller than the
      // window is normal, and Playwright scrolls to the target exactly as a
      // user would.
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

      // ...and it all survives a reload at this width.
      await page.reload();
      await expectDashboardReady(page);
      await expect(checkbox(page, name)).toBeChecked();
    });
  }

  /**
   * A habit whose name is long enough to be ordinary and short enough to be
   * unremarkable. 19 characters, against a form that accepts 60.
   */
  const ORDINARY_LONG_NAME = "毎朝のストレッチと深呼吸をきちんとやる";

  /**
   * The widest content the product itself accepts.
   *
   * Not invented numbers: `client/src/data/document.ts` caps a name at 60
   * characters, a unit at 12, and both a target and a recorded value at
   * 1,000,000. A layout that only holds for short names is a layout that breaks
   * on data the app will happily store.
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
      // always drawn one; it is not the page's layout coming apart.
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

  test("AC-6.5/AC-7.14: even the widest content the product accepts does not scroll the page", async ({
    page,
  }) => {
    // A numeric habit at every limit at once, with today already at the maximum
    // value: "1000000 / 1000000 ペペペペペペペペペペペペ" — plus a deleted habit
    // with a record, so the picker also carries a 「（削除済み）」 option.
    await openDashboard(page, {
      habits: [
        { id: 1, name: MAX_NAME, kind: "numeric", target: MAX_NUMBER, unit: MAX_UNIT },
        { id: 2, name: DELETED_NAME, kind: "boolean", archived_at: "2026-03-10T00:00:00.000Z" },
      ],
      entries: { 1: { [TODAY]: MAX_NUMBER }, 2: { [TODAY]: 1 } },
    });
    await expect(heatmapGrid(page)).toBeVisible();

    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(heatmapGrid(page)).toBeVisible();

      // Each of the three kinds of view the picker can be in: the overall map,
      // an active habit's own, and a deleted habit's own. They render different
      // labels, and the label is what sizes the control.
      for (const option of [OVERALL_OPTION, MAX_NAME, `${DELETED_NAME}（削除済み）`]) {
        await heatmapPicker(page).selectOption({ label: option });
        await expect(page.getByRole("grid", { name: `${option} の年間ヒートマップ` })).toBeVisible();

        const measured = await measureWidths(page, width);
        const where = `${width}px / ${option.slice(0, 12)}…`;

        expect(
          measured.body,
          `document.body scrolls sideways at ${where}: ${JSON.stringify(measured)}`,
        ).toBeLessThanOrEqual(1);
        expect(measured.root, `documentElement scrolls sideways at ${where}`).toBeLessThanOrEqual(1);
        expect(measured.pastRightEdge, `elements drawn past the right edge at ${where}`).toEqual([]);
        expect(measured.scrollingInside, `elements scrolling internally at ${where}`).toEqual([]);

        await expectWithinViewportWidth(page, heatmapPicker(page), `表示する習慣 at ${where}`);
      }
    }

    // The number box does scroll its own value at 375px (a seven-digit number in
    // a 5.5rem field). That is the browser drawing an <input>, not the page
    // breaking — so what is asserted is what a user would actually notice:
    await page.setViewportSize({ width: 375, height: 800 });
    const row = habitRow(page, MAX_NAME);
    const field = amountField(page, MAX_NAME);

    await expectWithinViewportWidth(page, field, "数値入力欄 at 375px");
    await expect(row).toContainText(`${MAX_NUMBER} / ${MAX_NUMBER} ${MAX_UNIT}`);
    await field.fill("12");
    await expect(row).toContainText(`12 / ${MAX_NUMBER} ${MAX_UNIT}`);
    await page.reload();
    await expectDashboardReady(page);
    await expect(amountField(page, MAX_NAME)).toHaveValue("12");
  });

  test("AC-6.5/AC-7.14: an ordinary long habit name does not scroll the page either", async ({ page }) => {
    // The case that actually regressed in Phase 6: 19 characters, nothing exotic.
    await openDashboard(page, { habits: [{ id: 1, name: ORDINARY_LONG_NAME, kind: "boolean" }] });
    await expect(heatmapGrid(page)).toBeVisible();

    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(heatmapGrid(page)).toBeVisible();

      const measured = await measureWidths(page, width);
      expect(
        measured.body,
        `document.body scrolls sideways at ${width}px: ${JSON.stringify(measured)}`,
      ).toBeLessThanOrEqual(1);
      expect(measured.root, `documentElement scrolls sideways at ${width}px`).toBeLessThanOrEqual(1);
      expect(measured.pastRightEdge, `elements drawn past the right edge at ${width}px`).toEqual([]);

      await expectWithinViewportWidth(page, heatmapPicker(page), `表示する習慣 at ${width}px`);
    }
  });

  // -------------------------------------------------------------------------
  // Readings that Phase 6's layout fix touched, re-read from the screen.
  // -------------------------------------------------------------------------

  test("AC-3.2 regression: '0 / 30 分' stays on one readable line at every width", async ({ page }) => {
    const name = "P6_進捗行_瞑想";
    await openDashboard(page, { habits: [{ id: 1, name, kind: "numeric", target: 30, unit: "分" }] });

    const row = habitRow(page, name);
    await expect(row).toBeVisible();

    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });

      // The AC's own example, character for character.
      const progress = row.getByText("0 / 30 分", { exact: true });
      await expect(progress, `"0 / 30 分" is not on screen at ${width}px`).toBeVisible();

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
  });

  test("AC-3.2 regression: ordinary progress lines do not wrap at any width", async ({ page }) => {
    const cases = [
      { id: 1, name: "P6_折返し_瞑想", target: 30, unit: "分", value: 0, reads: "0 / 30 分" },
      { id: 2, name: "P6_折返し_腕立て", target: 100, unit: "回", value: 120, reads: "120 / 100 回" },
      { id: 3, name: "P6_折返し_読書", target: 2000, unit: "ページ", value: 1500, reads: "1500 / 2000 ページ" },
      { id: 4, name: "P6_折返し_歩数", target: 10000, unit: "歩", value: 12345, reads: "12345 / 10000 歩" },
      { id: 5, name: "P6_折返し_学習", target: 180, unit: "分間の学習", value: 90.5, reads: "90.5 / 180 分間の学習" },
    ] as const;

    const entries: Record<number, Record<string, number>> = {};
    for (const item of cases) if (item.value > 0) entries[item.id] = { [TODAY]: item.value };

    await openDashboard(page, {
      habits: cases.map((item) => ({
        id: item.id,
        name: item.name,
        kind: "numeric" as const,
        target: item.target,
        unit: item.unit,
      })),
      entries,
    });

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
  });

  test("the picker's accessible name survives the title attribute, and the cells' tooltip is unchanged", async ({
    page,
  }) => {
    const name = "P6_タイトル属性_確認";
    await openDashboard(page, {
      habits: [{ id: 1, name, kind: "boolean" }],
      entries: { 1: { [TODAY]: 1 } },
    });
    await expect(heatmapGrid(page)).toBeVisible();

    await expect(page.getByRole("combobox", { name: "表示する習慣" })).toHaveCount(1);
    await expect(heatmapPicker(page)).toHaveAccessibleName("表示する習慣");

    await heatmapPicker(page).selectOption({ label: name });
    await expect(heatmapPicker(page)).toHaveAccessibleName("表示する習慣");
    await expect(heatmapPicker(page)).toHaveAttribute("title", name);

    await expect(page.getByRole("option", { name })).toHaveCount(1);

    // The heatmap's own tooltip still comes from the cell's accessible name.
    const cell = cellFor(page, TODAY);
    await expect(cell).toHaveAccessibleName(`${TODAY} 達成`);
    expect(await cell.getAttribute("title")).toBeNull();

    await cell.hover();
    const tip = page.getByText(`${TODAY} 達成`, { exact: true });
    await expect(tip).toHaveCount(1);
    await expect(tip).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // "Today" is re-read while the page is open. Every date-dependent number on
  // screen is a function of it, and a wrong answer here is silent.
  // -------------------------------------------------------------------------

  test("crossing midnight moves the whole dashboard to the new day", async ({ page }) => {
    const name = "P6_日跨ぎ";
    await openDashboard(page, {
      habits: [{ id: 1, name, kind: "boolean" }],
      entries: { 1: byDaysAgo({ 0: 1, 1: 1 }) },
    });
    await expectHeatmapReady(page);

    await expect(page.getByTestId("today-date")).toHaveText(TODAY);
    await expect(statsAsOf(page)).toHaveText(`${TODAY} 時点`);
    await expect(heatmapGrid(page)).toHaveAccessibleName(new RegExp(`〜 ${TODAY}`));
    await expect(statsRow(page, name)).toContainText("現在ストリーク 2 日");

    // 09:00 on the pinned day → 09:00 the next day.
    await page.clock.fastForward("24:00:00");

    const tomorrow = "2026-03-16";
    await expect(page.getByTestId("today-date")).toHaveText(tomorrow);
    await expect(statsAsOf(page)).toHaveText(`${tomorrow} 時点`);
    await expect(heatmapGrid(page)).toHaveAccessibleName(new RegExp(`〜 ${tomorrow}`));
    // The grid's right-hand edge really is the new day.
    await expect(cellFor(page, tomorrow)).toHaveCount(1);

    // The new day has no record yet, and today-is-not-over means the streak is
    // still the two days behind it.
    await expect(checkbox(page, name)).not.toBeChecked();
    await expect(statsRow(page, name)).toContainText("現在ストリーク 2 日");

    // ...and a tick on the new day is written against the new day.
    await checkbox(page, name).check();
    const stored = JSON.parse((await readStorage(page)) as string) as {
      entries: Record<string, Record<string, number>>;
    };
    expect(stored.entries["1"]?.[tomorrow]).toBe(1);
    expect(stored.entries["1"]?.[TODAY], "yesterday's record was overwritten").toBe(1);
  });

  // -------------------------------------------------------------------------
  // Behaviour Phase 6 added on its own initiative, re-read after the move.
  // -------------------------------------------------------------------------

  test("a numeric habit with no target is readable, and 'any value counts' holds everywhere", async ({ page }) => {
    const name = "P6_目標なし_読書";
    await openDashboard(page);

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
    await expect(statsRow(page, name)).toContainText("現在ストリーク 1 日");

    // ...and so does the heatmap cell, which has no ratio to work from.
    await heatmapPicker(page).selectOption({ label: name });
    await expect(page.getByRole("grid", { name: `${name} の年間ヒートマップ` })).toBeVisible();
    await expect(cellFor(page, TODAY)).toHaveAccessibleName(`${TODAY} 3 ページ 達成`);
  });

  test("AC-3.6 regression: delete still removes the habit, and the undo brings it back with its records", async ({
    page,
  }) => {
    const name = "P6_取り消し_腕立て";
    const past = daysAgo(3);
    await openDashboard(page, {
      habits: [{ id: 1, name, kind: "boolean" }],
      entries: { 1: { [past]: 1 } },
    });
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
    const stored = JSON.parse((await readStorage(page)) as string) as {
      entries: Record<string, Record<string, number>>;
    };
    expect(Object.keys(stored.entries["1"] ?? {})).toContain(past);
  });

  test("a document written by this build is readable by this build", async ({ page }) => {
    // The round trip that matters after a schema change: what the app writes has
    // to be what the app's own parser accepts, or the next reload is AC-7.6's
    // failure path for everybody.
    await openDashboard(page);
    await nameField(page).fill("P6_往復_散歩");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();
    await checkbox(page, "P6_往復_散歩").check();

    const written = (await readStorage(page)) as string;

    await open(page);
    await seedRaw(page, written);
    await expectDashboardReady(page);
    await expect(habitRow(page, "P6_往復_散歩")).toBeVisible();
    await expect(checkbox(page, "P6_往復_散歩")).toBeChecked();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a hand-written document in the documented shape is accepted", async ({ page }) => {
    // docs/design.md and the builder's own hand-off describe the stored shape.
    // A document written from that description alone has to work, or the
    // documentation is wrong.
    await seedRaw(
      page,
      documentText({
        habits: [{ id: 1, name: "散歩", kind: "boolean" }],
        entries: { 1: { "2026-03-15": 1, "2026-03-14": 0 } },
        next_habit_id: 3,
      }),
    );
    await expectDashboardReady(page);

    await expect(habitRow(page, "散歩")).toBeVisible();
    await expect(checkbox(page, "散歩")).toBeChecked();
    await expect(statsRow(page, "散歩")).toContainText("現在ストリーク 1 日");

    // The habit's own view: yesterday was recorded as not done, which the cell
    // has to distinguish from a day with no record at all.
    await heatmapPicker(page).selectOption({ label: "散歩" });
    await expect(cellFor(page, "2026-03-14")).toHaveAccessibleName("2026-03-14 未達成");
    await expect(cellFor(page, "2026-03-13")).toHaveAccessibleName("2026-03-13 記録なし");
  });
});

// ---------------------------------------------------------------------------

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
