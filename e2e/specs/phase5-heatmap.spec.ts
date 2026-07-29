import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { TODAY, daysAgo, expect, expectDashboardReady, test } from "../fixtures.ts";
import { E2E_DB_PATH } from "../playwright.config.ts";

// Phase 5 acceptance criteria under test here:
//
//   AC-5.1 [E2E] A year of heatmap is drawn; 7 rows × 52–53 columns of cells.
//   AC-5.2 [E2E] A day with a record is painted differently from a day without one.
//   AC-5.3 [E2E] For a numeric habit, a higher ratio to the goal is a darker cell
//                (at least three steps apart).
//   AC-5.4 [E2E] Every cell carries an accessible name holding its date and value.
//   AC-5.5 [E2E] At 375px the page body does not scroll sideways; only the
//                heatmap's own container does.
//   AC-5.6 [E2E] In light *and* dark mode, "no record" and the faintest "recorded"
//                are drawn as different colours.
//   AC-5.7        No chart library — the grid is SVG drawn by this repo.
//
// Two rules shape everything below.
//
// **The paint is read from the browser, never from an attribute.** AC-5.2/5.3/5.6
// are about what is *drawn*. `data-level` is the implementation's own bookkeeping,
// so a cell whose level differs but whose colour does not would satisfy it while
// failing the criterion. Every colour assertion here therefore goes through
// `getComputedStyle(cell).fill`.
//
// **The clock is pinned** (2026-03-15, shared fixture) and every seeded day is an
// offset from it. A heatmap is a year of "which day is it" answers; against a real
// clock this file would decay silently.
//
// The E2E database is wiped once per run and shared by all specs, so the *overall*
// view's denominator is whatever habits earlier phases left behind. Assertions
// that need a known denominator use the per-habit view; assertions that only need
// "recorded vs not" use days far enough back (200+) that no other spec has touched
// them.

const DB_FILE = path.resolve(import.meta.dirname, "../..", E2E_DB_PATH);

function readEntryDates(habitId: number): string[] {
  const db = new DatabaseSync(DB_FILE);
  try {
    return (
      db.prepare("SELECT date FROM entries WHERE habit_id = ? ORDER BY date").all(habitId) as unknown as Array<{
        date: string;
      }>
    ).map((row) => row.date);
  } finally {
    db.close();
  }
}

function readEntryValue(habitId: number, date: string): number | undefined {
  const db = new DatabaseSync(DB_FILE);
  try {
    const row = db.prepare("SELECT value FROM entries WHERE habit_id = ? AND date = ?").get(habitId, date) as
      | { value: number }
      | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Screen vocabulary — role and accessible name only.
// ---------------------------------------------------------------------------

const heatmapHeading = (page: Page) => page.getByRole("heading", { name: "年間ヒートマップ" });
const heatmapGrid = (page: Page) => page.getByRole("grid", { name: /年間ヒートマップ/ });
const habitPicker = (page: Page) => page.getByLabel("表示する習慣");
const cellFor = (page: Page, date: string) => page.getByRole("gridcell", { name: date });

const habitList = (page: Page) => page.getByRole("list", { name: "習慣一覧" });
const habitRow = (page: Page, name: string) => habitList(page).getByRole("listitem").filter({ hasText: name });
const amountField = (page: Page, name: string) => page.getByRole("spinbutton", { name });
const checkbox = (page: Page, name: string) => page.getByRole("checkbox", { name });

/** Waits until the heatmap has finished loading, whichever way it went. */
async function expectHeatmapReady(page: Page): Promise<void> {
  await expect(heatmapHeading(page)).toBeVisible();
  await expect(heatmapGrid(page)).toBeVisible();
}

/** Switches the heatmap to one habit, and waits for the grid to say so. */
async function showHabit(page: Page, name: string): Promise<void> {
  await habitPicker(page).selectOption({ label: name });
  await expect(page.getByRole("grid", { name: `${name} の年間ヒートマップ` })).toBeVisible();
}

async function showOverall(page: Page): Promise<void> {
  await habitPicker(page).selectOption({ label: "全体" });
  await expect(page.getByRole("grid", { name: "全体 の年間ヒートマップ" })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Reading the drawing.
// ---------------------------------------------------------------------------

/**
 * The colour the browser actually paints the cell for `date`.
 *
 * `fill` and not `data-level`: the criterion is about what a reader sees, and the
 * two can disagree.
 */
async function fillOf(page: Page, date: string): Promise<string> {
  const cell = cellFor(page, date);
  await expect(cell, `exactly one cell for ${date}`).toHaveCount(1);
  return cell.evaluate((element) => getComputedStyle(element).fill);
}

/** WCAG relative luminance, so "darker" is a number and not an opinion. */
function luminanceOf(colour: string): number {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(colour);
  if (match === null) throw new Error(`not an rgb colour: ${JSON.stringify(colour)}`);

  const [r, g, b] = [match[1], match[2], match[3]].map((part) => {
    const channel = Number(part) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

type RowInfo = { label: string; names: string[] };

/**
 * The grid as a screen reader meets it: rows in the order they are announced,
 * each with the accessible names of its cells.
 *
 * Read through the ARIA attributes rather than the class names, so a restyle
 * cannot break this and a broken a11y tree cannot pass it.
 */
async function readRows(page: Page): Promise<RowInfo[]> {
  return heatmapGrid(page).evaluate((svg) =>
    Array.from(svg.querySelectorAll('[role="row"]')).map((row) => ({
      label: row.getAttribute("aria-label") ?? "",
      names: Array.from(row.querySelectorAll('[role="gridcell"]')).map(
        (cell) => cell.getAttribute("aria-label") ?? "",
      ),
    })),
  );
}

/**
 * The weekday of a `YYYY-MM-DD` string — written here rather than imported from
 * `shared/heatmap.ts`, so the row labels are checked against an independent
 * answer instead of against the code that produced them.
 */
const WEEKDAY_NAMES = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"] as const;

function weekdayNameOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return WEEKDAY_NAMES[day] as string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

// ---------------------------------------------------------------------------
// Seeding. Only today is editable through the UI, so history goes in over the
// same endpoint the UI itself calls.
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

test.describe("Phase 5 — year heatmap", () => {
  // -------------------------------------------------------------------------
  // AC-5.1
  // -------------------------------------------------------------------------

  test("AC-5.1: a year of cells, 7 rows by 52–53 columns, ending on today", async ({ loggedInPage: page }) => {
    // The panel only draws once there is something to draw, so give it a habit
    // of its own rather than relying on what earlier specs left behind.
    await createHabit(page, { name: "HM_基準_描画", kind: "boolean" });
    await page.reload();
    await expectDashboardReady(page);
    await expectHeatmapReady(page);

    const rows = await readRows(page);

    expect(rows, "one row per weekday").toHaveLength(7);

    for (const [index, row] of rows.entries()) {
      expect(row.names.length, `row ${index} column count`).toBeGreaterThanOrEqual(52);
      expect(row.names.length, `row ${index} column count`).toBeLessThanOrEqual(53);
    }

    const dates = rows.flatMap((row) => row.names.map((name) => name.slice(0, 10)));
    expect(dates.length, "7 × 52–53 cells").toBeGreaterThanOrEqual(7 * 52);
    expect(dates.length, "7 × 52–53 cells").toBeLessThanOrEqual(7 * 53);

    // A grid of the right size could still be the wrong year. Every cell is a
    // real, distinct, non-future day, and the window really is about a year.
    for (const date of dates) expect(date, `cell date ${date}`).toMatch(ISO_DATE);
    expect(new Set(dates).size, "no day is drawn twice").toBe(dates.length);

    const sorted = [...dates].sort();
    const oldest = sorted[0] as string;
    const newest = sorted[sorted.length - 1] as string;

    expect(newest, "the newest cell is today").toBe(TODAY);
    expect(oldest >= daysAgo(371), `oldest cell ${oldest} is not more than 371 days back`).toBe(true);
    expect(oldest <= daysAgo(363), `oldest cell ${oldest} is at least a year back`).toBe(true);

    // No gaps: a year of consecutive days, so the count and the span agree.
    const span = Math.round(
      (Date.parse(`${newest}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000 + 1,
    );
    expect(span, "the cells cover consecutive days with no holes").toBe(dates.length);

    // Today is reachable by name, as the right-hand edge of the drawing.
    await expect(cellFor(page, TODAY)).toHaveCount(1);
  });

  test("AC-5.1: each row is labelled with the weekday its cells actually fall on", async ({
    loggedInPage: page,
  }) => {
    await expectHeatmapReady(page);
    const rows = await readRows(page);

    for (const [index, row] of rows.entries()) {
      const dates = row.names.map((name) => name.slice(0, 10));
      const weekdays = new Set(dates.map(weekdayNameOf));

      // The grid is anchored on today rather than on a Sunday, so a row's
      // weekday is whatever today's offset makes it — but it must be *one*
      // weekday, and the label must be that one.
      expect(weekdays.size, `row ${index} mixes weekdays: ${[...weekdays].join(", ")}`).toBe(1);
      expect(row.label, `row ${index} label vs its dates (${dates[0]})`).toBe(weekdayNameOf(dates[0] as string));
    }

    // ...and the seven rows are seven different weekdays, not the same one seven
    // times.
    expect(new Set(rows.map((row) => row.label)).size).toBe(7);
  });

  // -------------------------------------------------------------------------
  // AC-5.4
  // -------------------------------------------------------------------------

  test("AC-5.4: every cell announces its date, and a recorded day announces its value", async ({
    loggedInPage: page,
  }) => {
    const name = "HM_ラベル_読書";
    const id = await createHabit(page, { name, kind: "numeric", target: 30, unit: "分" });

    const done = daysAgo(220);
    const short = daysAgo(221);
    const blank = daysAgo(222);
    await seedDays(page, id, { 220: 30, 221: 12 });

    await page.reload();
    await expectHeatmapReady(page);

    // Every one of the cells, not just the interesting ones: a name that is
    // missing or empty is unreachable for a screen reader and for getByRole.
    const rows = await readRows(page);
    for (const row of rows) {
      for (const label of row.names) {
        expect(label, "cell accessible name").not.toBe("");
        expect(label, "cell accessible name starts with its ISO date").toMatch(ISO_DATE);
      }
    }

    await showHabit(page, name);

    // Reached the way a screen reader reaches it, and carrying the value.
    await expect(cellFor(page, done)).toHaveAccessibleName(`${done} 30 / 30 分 達成`);
    await expect(cellFor(page, short)).toHaveAccessibleName(`${short} 12 / 30 分 未達成`);
    await expect(cellFor(page, blank)).toHaveAccessibleName(`${blank} 記録なし`);

    // The overall view names the day too, with how much of it was done.
    await showOverall(page);
    await expect(cellFor(page, done)).toHaveAccessibleName(new RegExp(`^${done} \\d+ / \\d+ 習慣 達成$`));
    await expect(cellFor(page, blank)).toHaveAccessibleName(`${blank} 記録なし`);
  });

  // -------------------------------------------------------------------------
  // AC-5.2
  // -------------------------------------------------------------------------

  test("AC-5.2: a recorded day is painted differently from a day with no record", async ({
    loggedInPage: page,
  }) => {
    const name = "HM_記録あり_散歩";
    const id = await createHabit(page, { name, kind: "boolean" });

    const doneDay = daysAgo(300);
    const missedDay = daysAgo(301); // recorded, explicitly not done
    const blankDay = daysAgo(302); // no row at all
    await seedDays(page, id, { 300: 1, 301: 0 });

    // The three days really are what the test says they are.
    expect(readEntryDates(id).sort()).toEqual([doneDay, missedDay].sort());

    await page.reload();
    await expectHeatmapReady(page);
    await showHabit(page, name);

    const done = await fillOf(page, doneDay);
    const missed = await fillOf(page, missedDay);
    const blank = await fillOf(page, blankDay);

    expect(done, `achieved ${doneDay} vs blank ${blankDay}`).not.toBe(blank);
    // A day the user turned up for and did not finish is still a day with a
    // record — it must not read as an empty day.
    expect(missed, `recorded-but-not-done ${missedDay} vs blank ${blankDay}`).not.toBe(blank);

    // Negative control: two days that are both blank must be identical, or the
    // comparison above would pass for any two cells at all.
    expect(await fillOf(page, daysAgo(303))).toBe(blank);
    expect(await fillOf(page, daysAgo(304))).toBe(blank);

    // The same must hold in the view a user first lands on.
    await showOverall(page);
    expect(await fillOf(page, doneDay), "overall view: recorded vs blank").not.toBe(
      await fillOf(page, blankDay),
    );
    expect(await fillOf(page, missedDay), "overall view: recorded-but-not-done vs blank").not.toBe(
      await fillOf(page, blankDay),
    );
  });

  // -------------------------------------------------------------------------
  // AC-5.3
  // -------------------------------------------------------------------------

  test("AC-5.3: for a numeric habit, a higher ratio to the goal is a darker cell", async ({
    loggedInPage: page,
  }) => {
    const name = "HM_濃淡_瞑想";
    const id = await createHabit(page, { name, kind: "numeric", target: 30, unit: "分" });

    // Six days, strictly increasing towards the goal of 30.
    const values: Array<[number, number]> = [
      [200, 0],
      [201, 3],
      [202, 12],
      [203, 21],
      [204, 29],
      [205, 30],
    ];
    await seedDays(page, id, Object.fromEntries(values));

    await page.reload();
    await expectHeatmapReady(page);
    // The overall view's shade is "achieved habits / all habits", so a single
    // numeric habit short of its goal is one flat step there whatever the value.
    // The ratio to the goal is a per-habit statement and is read in that view.
    await showHabit(page, name);

    const measured: Array<{ value: number; date: string; fill: string; luminance: number }> = [];
    for (const [offset, value] of values) {
      const date = daysAgo(offset);
      const fill = await fillOf(page, date);
      measured.push({ value, date, fill, luminance: luminanceOf(fill) });
    }

    const report = measured.map((m) => `${m.value} → ${m.fill}`).join(", ");

    // Monotone: no day with a higher value may be painted lighter than a day
    // with a lower one.
    for (let i = 1; i < measured.length; i += 1) {
      const previous = measured[i - 1] as (typeof measured)[number];
      const current = measured[i] as (typeof measured)[number];
      expect(
        current.luminance,
        `value ${current.value} must not be lighter than value ${previous.value} (${report})`,
      ).toBeLessThanOrEqual(previous.luminance + 1e-9);
    }

    // ...and at least three of the steps are actually distinguishable, or
    // "monotone" is satisfied by painting everything the same colour.
    const distinct = new Set(measured.map((m) => m.fill));
    expect(distinct.size, `distinguishable steps among ${report}`).toBeGreaterThanOrEqual(3);

    // The goal being met is the darkest step, and it is darker than every day
    // that fell short.
    const met = measured[measured.length - 1] as (typeof measured)[number];
    for (const other of measured.slice(0, -1)) {
      expect(met.fill, `goal met (${met.fill}) vs value ${other.value} (${other.fill})`).not.toBe(other.fill);
    }

    // ...and every one of them differs from a day with no record at all.
    const blank = await fillOf(page, daysAgo(206));
    for (const m of measured) {
      expect(m.fill, `value ${m.value} vs no record (${blank})`).not.toBe(blank);
    }

    // Dark mode reads the same criterion the only way it can: on a dark surface
    // "darker ink" is more contrast, not less luminance, so the ramp is checked
    // against the surface it is drawn on rather than against absolute black.
    await page.emulateMedia({ colorScheme: "dark" });
    try {
      const surface = luminanceOf(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
      const dark: Array<{ value: number; fill: string; contrast: number }> = [];
      for (const [offset, value] of values) {
        const fill = await fillOf(page, daysAgo(offset));
        dark.push({ value, fill, contrast: Math.abs(luminanceOf(fill) - surface) });
      }

      const darkReport = dark.map((m) => `${m.value} → ${m.fill}`).join(", ");
      for (let i = 1; i < dark.length; i += 1) {
        const previous = dark[i - 1] as (typeof dark)[number];
        const current = dark[i] as (typeof dark)[number];
        expect(
          current.contrast,
          `dark mode: value ${current.value} stands out less than ${previous.value} (${darkReport})`,
        ).toBeGreaterThanOrEqual(previous.contrast - 1e-9);
      }
      expect(new Set(dark.map((m) => m.fill)).size, `dark mode steps: ${darkReport}`).toBeGreaterThanOrEqual(3);
    } finally {
      await page.emulateMedia({ colorScheme: "light" });
    }
  });

  // -------------------------------------------------------------------------
  // AC-5.6
  // -------------------------------------------------------------------------

  test("AC-5.6: no-record and the faintest recorded day differ in light and in dark mode", async ({
    loggedInPage: page,
  }) => {
    const name = "HM_配色_水やり";
    const id = await createHabit(page, { name, kind: "boolean" });

    const faintDay = daysAgo(250); // recorded, not done — the lightest ink there is
    const blankDay = daysAgo(251);
    await seedDays(page, id, { 250: 0 });

    await page.reload();
    await expectHeatmapReady(page);
    await showHabit(page, name);

    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });

      const faint = await fillOf(page, faintDay);
      const blank = await fillOf(page, blankDay);

      expect(faint, `${scheme}: faintest recorded (${faint}) vs no record (${blank})`).not.toBe(blank);

      // "Different" has to mean visibly different, not one step of rounding.
      const separation = Math.abs(luminanceOf(faint) - luminanceOf(blank));
      expect(separation, `${scheme}: luminance gap between ${faint} and ${blank}`).toBeGreaterThan(0.01);

      // The scheme really did change — otherwise the dark pass is the light pass
      // measured twice.
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(background, `${scheme} background`).not.toBe("");
      if (scheme === "dark") {
        expect(luminanceOf(background), "dark mode surface is dark").toBeLessThan(0.2);
      } else {
        expect(luminanceOf(background), "light mode surface is light").toBeGreaterThan(0.5);
      }
    }

    await page.emulateMedia({ colorScheme: "light" });
    expect(readEntryDates(id)).toEqual([faintDay]);
  });

  // -------------------------------------------------------------------------
  // AC-5.5
  // -------------------------------------------------------------------------

  test("AC-5.5: at 375px only the heatmap's container scrolls sideways", async ({ loggedInPage: page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await page.reload();
    await expectDashboardReady(page);
    await expectHeatmapReady(page);

    const measurements = await heatmapGrid(page).evaluate((svg) => {
      const doc = svg.ownerDocument as Document;

      let node: Element | null = svg.parentElement;
      let scroller: Element | null = null;
      const ancestors: string[] = [];

      while (node !== null) {
        const style = getComputedStyle(node);
        ancestors.push(
          `${node.tagName.toLowerCase()}[overflow-x=${style.overflowX}, scrollWidth=${node.scrollWidth}, clientWidth=${node.clientWidth}]`,
        );
        if (
          scroller === null &&
          node.scrollWidth > node.clientWidth + 1 &&
          (style.overflowX === "auto" || style.overflowX === "scroll")
        ) {
          scroller = node;
        }
        node = node.parentElement;
      }

      let scrolledTo = 0;
      if (scroller !== null) {
        scroller.scrollLeft = 9999;
        scrolledTo = scroller.scrollLeft;
        scroller.scrollLeft = 0;
      }

      return {
        ancestors,
        svgWidth: Math.round(svg.getBoundingClientRect().width),
        scrollerTag: scroller === null ? null : scroller.tagName.toLowerCase(),
        scrollerIsPageLevel: scroller === doc.body || scroller === doc.documentElement,
        scrolledTo,
        bodyScrollWidth: doc.body.scrollWidth,
        bodyClientWidth: doc.body.clientWidth,
        docScrollWidth: doc.documentElement.scrollWidth,
        docClientWidth: doc.documentElement.clientWidth,
        innerWidth: window.innerWidth,
      };
    });

    // The drawing really is wider than the viewport — otherwise "the page does
    // not scroll" is true for an empty page and proves nothing.
    expect(measurements.svgWidth, `heatmap width vs viewport (${JSON.stringify(measurements)})`).toBeGreaterThan(
      375,
    );

    // The page itself does not scroll sideways. One pixel of slack for
    // sub-pixel layout rounding; anything a user could actually drag is larger.
    expect(
      measurements.bodyScrollWidth,
      `document.body scrolls sideways: ${JSON.stringify(measurements)}`,
    ).toBeLessThanOrEqual(measurements.bodyClientWidth + 1);
    expect(
      measurements.docScrollWidth,
      `documentElement scrolls sideways: ${JSON.stringify(measurements)}`,
    ).toBeLessThanOrEqual(measurements.docClientWidth + 1);

    // ...and the scrolling that does happen happens inside the heatmap.
    expect(measurements.scrollerTag, `no scrollable container: ${JSON.stringify(measurements)}`).not.toBeNull();
    expect(measurements.scrollerIsPageLevel, "the page itself is the scroller").toBe(false);
    expect(measurements.scrolledTo, "the heatmap container does not actually scroll").toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // AC-5.7
  // -------------------------------------------------------------------------

  test("AC-5.7: the grid is inline SVG drawn by the page, not a charting canvas", async ({
    loggedInPage: page,
  }) => {
    await expectHeatmapReady(page);

    const drawing = await heatmapGrid(page).evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      namespace: element.namespaceURI,
      rects: element.querySelectorAll("rect").length,
      canvases: document.querySelectorAll("canvas").length,
    }));

    expect(drawing.tag).toBe("svg");
    expect(drawing.namespace).toBe("http://www.w3.org/2000/svg");
    expect(drawing.rects, "the cells are plain <rect>s").toBeGreaterThanOrEqual(7 * 52);
    expect(drawing.canvases, "nothing is drawn on a canvas").toBe(0);
  });

  // -------------------------------------------------------------------------
  // Regression: Phase 5 put a 300 ms debounce on the numeric field
  // (client/src/components/TodayPanel.tsx). AC-3.4 says a typed value survives a
  // reload — the case that debounce endangers is typing and reloading straight
  // away, before the timer expires.
  // -------------------------------------------------------------------------

  test("AC-3.4 regression: a value typed and reloaded immediately is not lost", async ({
    loggedInPage: page,
  }) => {
    const name = "HM_デバウンス_腹筋";
    const id = await createHabit(page, { name, kind: "numeric", target: 50, unit: "回" });

    await page.reload();
    await expectDashboardReady(page);

    // Typed and then reloaded with no wait at all: the debounce has not fired.
    await amountField(page, name).fill("42");
    await page.reload();

    await expectDashboardReady(page);
    await expect(amountField(page, name)).toHaveValue("42");
    await expect(habitRow(page, name)).toContainText("42 / 50 回");
    expect(readEntryValue(id, TODAY), "the typed value reached the database").toBe(42);
  });

  test("AC-3.4 regression: typing digit by digit stores the final value, once", async ({
    loggedInPage: page,
  }) => {
    const name = "HM_デバウンス_連打";
    const id = await createHabit(page, { name, kind: "numeric", target: 100, unit: "回" });

    await page.reload();
    await expectDashboardReady(page);

    const field = amountField(page, name);
    await field.click();
    await field.fill("");
    await field.pressSequentially("120", { delay: 40 });

    // The row follows the keystrokes even though the write has not gone out yet.
    await expect(habitRow(page, name)).toContainText("120 / 100 回");
    await expect(habitRow(page, name).getByText("達成", { exact: true })).toBeVisible();

    await field.blur();
    await page.reload();
    await expectDashboardReady(page);

    await expect(amountField(page, name)).toHaveValue("120");
    expect(readEntryValue(id, TODAY)).toBe(120);
    // One day, one row — the debounce must not have written 1, 12 and 120 as
    // three separate records, and must not have lost the last one.
    expect(readEntryDates(id)).toEqual([TODAY]);
  });

  test("AC-3.3 regression: the checkbox still writes immediately", async ({ loggedInPage: page }) => {
    const name = "HM_デバウンス_チェック";
    const id = await createHabit(page, { name, kind: "boolean" });

    await page.reload();
    await expectDashboardReady(page);

    await checkbox(page, name).check();
    await page.reload();

    await expectDashboardReady(page);
    await expect(checkbox(page, name)).toBeChecked();
    expect(readEntryValue(id, TODAY)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Interpretation checks — recorded here because they pin down behaviour the
  // ACs leave open, not because an AC demands them.
  // -------------------------------------------------------------------------

  test("interpretation: recording today repaints the heatmap without a reload", async ({
    loggedInPage: page,
  }) => {
    const name = "HM_即時反映_日記";
    await createHabit(page, { name, kind: "boolean" });

    await page.reload();
    await expectDashboardReady(page);
    await expectHeatmapReady(page);
    await showHabit(page, name);

    const before = await fillOf(page, TODAY);
    await expect(cellFor(page, TODAY)).toHaveAccessibleName(`${TODAY} 記録なし`);

    await checkbox(page, name).check();

    await expect(cellFor(page, TODAY)).toHaveAccessibleName(`${TODAY} 達成`);
    expect(await fillOf(page, TODAY), "today's cell did not repaint").not.toBe(before);
  });
});
