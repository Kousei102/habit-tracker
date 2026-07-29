import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays } from "./domain.ts";
import {
  HEATMAP_COLUMNS,
  HEATMAP_DAYS,
  HEATMAP_ROWS,
  buildHeatmapGrid,
  habitCellLabel,
  habitLevel,
  heatmapStart,
  indexEntries,
  monthMarks,
  monthOf,
  overallCellLabel,
  overallLevel,
  weekdayName,
  weekdayOf,
} from "./heatmap.ts";
import type { Entry, Habit } from "./types.ts";

function habitOf(patch: Partial<Habit>): Habit {
  return {
    id: 1,
    name: "習慣",
    kind: "boolean",
    target: null,
    unit: null,
    color: "blue",
    sort_order: 0,
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

const check = habitOf({ id: 1, name: "ストレッチ", kind: "boolean" });
const minutes = habitOf({ id: 2, name: "瞑想", kind: "numeric", target: 30, unit: "分" });
const untargeted = habitOf({ id: 3, name: "読書", kind: "numeric", target: null, unit: "ページ" });

const TODAY = "2026-03-15";

describe("buildHeatmapGrid", () => {
  it("is a full rectangle of 7 rows × 53 columns", () => {
    const grid = buildHeatmapGrid(TODAY);

    assert.equal(grid.length, HEATMAP_COLUMNS);
    for (const column of grid) assert.equal(column.length, HEATMAP_ROWS);
    assert.equal(grid.flat().length, HEATMAP_DAYS);
  });

  it("ends on today — the right-hand edge is the browser's day", () => {
    const grid = buildHeatmapGrid(TODAY);
    const lastColumn = grid[grid.length - 1] as string[];

    assert.equal(lastColumn[lastColumn.length - 1], TODAY);
  });

  it("starts one whole window before today, with no gaps or repeats", () => {
    const grid = buildHeatmapGrid(TODAY);
    const days = grid.flat();

    assert.equal(days[0], heatmapStart(TODAY));
    assert.equal(days[0], "2025-03-10"); // 371 days back, inclusive of today
    assert.equal(new Set(days).size, HEATMAP_DAYS);
  });

  it("puts one weekday in each row, so the rows can be labelled", () => {
    const grid = buildHeatmapGrid(TODAY);

    for (let row = 0; row < HEATMAP_ROWS; row += 1) {
      const weekdays = new Set(grid.map((column) => weekdayOf(column[row] as string)));
      assert.equal(weekdays.size, 1, `row ${row} mixes weekdays`);
    }
  });

  it("crosses a leap day without drifting", () => {
    // 2028 is a leap year: a grid ending after 2028-02-29 must still land on
    // consecutive calendar days.
    const grid = buildHeatmapGrid("2028-03-01");
    const days = grid.flat();

    assert.ok(days.includes("2028-02-29"));
    assert.equal(days[days.length - 1], "2028-03-01");
    assert.equal(days[days.length - 2], "2028-02-29");
  });
});

describe("weekdayOf / monthOf", () => {
  it("reads the weekday of a date string", () => {
    assert.equal(weekdayOf("2026-03-15"), 0); // Sunday
    assert.equal(weekdayName("2026-03-15"), "日曜日");
    assert.equal(weekdayOf("2026-03-16"), 1);
    assert.equal(weekdayName("2026-03-21"), "土曜日");
  });

  it("reads the month of a date string", () => {
    assert.equal(monthOf("2026-03-15"), 3);
    assert.equal(monthOf("2026-12-01"), 12);
  });
});

describe("habitLevel — boolean habits", () => {
  it("is 0 with no record and 4 when done", () => {
    assert.equal(habitLevel(check, undefined), 0);
    assert.equal(habitLevel(check, 1), 4);
  });

  it("separates a stored zero from no record at all (AC-5.2)", () => {
    assert.equal(habitLevel(check, 0), 1);
    assert.notEqual(habitLevel(check, 0), habitLevel(check, undefined));
  });
});

describe("habitLevel — numeric habits", () => {
  it("darkens with the ratio to the goal, in at least three steps (AC-5.3)", () => {
    const levels = [3, 12, 21, 30].map((value) => habitLevel(minutes, value));

    assert.deepEqual(levels, [1, 2, 3, 4]);
    assert.equal(new Set(levels).size, 4);
  });

  it("reaches the top level only when the goal is met", () => {
    assert.equal(habitLevel(minutes, 29.9), 3);
    assert.equal(habitLevel(minutes, 30), 4);
    assert.equal(habitLevel(minutes, 60), 4); // overshooting is still one full day
  });

  it("treats a habit without a goal like a check: anything done is done", () => {
    assert.equal(habitLevel(untargeted, 0), 1);
    assert.equal(habitLevel(untargeted, 5), 4);
    assert.equal(habitLevel(untargeted, undefined), 0);
  });

  it("never reads a level out of a value that is not a number", () => {
    assert.equal(habitLevel(minutes, Number.NaN), 0);
  });
});

describe("overallLevel", () => {
  const habits = [check, minutes];

  it("is 0 for a day with no record", () => {
    assert.equal(overallLevel(habits, undefined), 0);
    assert.equal(overallLevel(habits, new Map()), 0);
  });

  it("is the darkest when every habit was achieved", () => {
    assert.equal(
      overallLevel(
        habits,
        new Map([
          [check.id, 1],
          [minutes.id, 30],
        ]),
      ),
      4,
    );
  });

  it("is a middle step when half the habits were achieved", () => {
    const level = overallLevel(
      habits,
      new Map([
        [check.id, 1],
        [minutes.id, 0],
      ]),
    );

    assert.equal(level, 2);
  });

  it("stays visible for a day that was recorded but achieved nothing (AC-5.2)", () => {
    const level = overallLevel(habits, new Map([[minutes.id, 5]]));

    assert.equal(level, 1);
    assert.notEqual(level, overallLevel(habits, undefined));
  });

  it("ignores records that belong to no listed (active) habit", () => {
    // The archived habit's entries survive its deletion, but they are not part
    // of "how much of the day did I do" any more.
    assert.equal(overallLevel(habits, new Map([[999, 1]])), 0);
  });

  it("does not divide by zero when there are no habits", () => {
    assert.equal(overallLevel([], new Map([[check.id, 1]])), 0);
  });
});

describe("monthMarks", () => {
  /** The real grid a year ends on `today` with. */
  function marksFor(today: string): Array<{ column: number; month: number }> {
    return monthMarks(buildHeatmapGrid(today));
  }

  it("labels every month boundary in the window", () => {
    // A year of daily windows: whichever day the grid ends on, no month may go
    // unlabelled except the sliver the grid opens in.
    for (let offset = 0; offset < 370; offset += 1) {
      const today = addDays("2026-03-15", -offset);
      const grid = buildHeatmapGrid(today);
      const marks = marksFor(today);

      // Every column where the month changes, taken independently of the code
      // under test.
      const boundaries: number[] = [];
      for (let column = 1; column < grid.length; column += 1) {
        const previous = monthOf((grid[column - 1] as string[])[0] as string);
        const month = monthOf((grid[column] as string[])[0] as string);
        if (month !== previous) boundaries.push(column);
      }

      const labelled = new Set(marks.map((mark) => mark.column));
      for (const column of boundaries) {
        assert.ok(
          labelled.has(column),
          `today=${today}: the month starting at column ${column} has no label (${JSON.stringify(marks)})`,
        );
      }

      // ...and every label names the month its column actually starts in.
      for (const mark of marks) {
        assert.equal(mark.month, monthOf((grid[mark.column] as string[])[0] as string));
      }

      // ...and no two labels are close enough to overlap.
      for (let index = 1; index < marks.length; index += 1) {
        const gap = (marks[index] as { column: number }).column - (marks[index - 1] as { column: number }).column;
        assert.ok(gap >= 3, `today=${today}: labels ${index - 1} and ${index} are ${gap} columns apart`);
      }
    }
  });

  it("keeps the leading label when the first month change is far enough away", () => {
    const grid = [["2026-01-01"], ["2026-01-08"], ["2026-01-15"], ["2026-01-22"], ["2026-01-29"], ["2026-02-05"]];

    assert.deepEqual(monthMarks(grid), [
      { column: 0, month: 1 },
      { column: 5, month: 2 },
    ]);
  });

  it("drops the opening sliver rather than the month boundary behind it", () => {
    // Column 0 is the tail of January; February starts one column later. Only
    // one of the two labels fits, and it is February's — the boundary that is
    // actually about to be true for the next five columns.
    const grid = [["2026-01-31"], ["2026-02-07"], ["2026-02-14"], ["2026-02-21"], ["2026-02-28"], ["2026-03-07"]];

    assert.deepEqual(monthMarks(grid), [
      { column: 1, month: 2 },
      { column: 5, month: 3 },
    ]);
  });

  it("survives an empty grid", () => {
    assert.deepEqual(monthMarks([]), []);
  });
});

describe("indexEntries", () => {
  it("groups records by date and habit", () => {
    const entries: Entry[] = [
      { habit_id: 1, date: "2026-03-14", value: 1, updated_at: "" },
      { habit_id: 2, date: "2026-03-14", value: 30, updated_at: "" },
      { habit_id: 1, date: "2026-03-15", value: 0, updated_at: "" },
    ];

    const index = indexEntries(entries);

    assert.equal(index.size, 2);
    assert.equal(index.get("2026-03-14")?.get(2), 30);
    assert.equal(index.get("2026-03-15")?.get(1), 0);
    assert.equal(index.get("2026-03-15")?.get(2), undefined);
  });
});

describe("cell labels", () => {
  it("leads with the ISO date so a day can be addressed by it (AC-5.4)", () => {
    assert.ok(overallCellLabel(TODAY, [check], undefined).startsWith(TODAY));
    assert.ok(habitCellLabel(minutes, TODAY, 30).startsWith(TODAY));
  });

  it("says how many habits were achieved out of how many", () => {
    const values = new Map([
      [check.id, 1],
      [minutes.id, 3],
    ]);

    assert.equal(overallCellLabel(TODAY, [check, minutes], values), `${TODAY} 1 / 2 習慣 達成`);
  });

  it("says 記録なし for a day with nothing recorded", () => {
    assert.equal(overallCellLabel(TODAY, [check], undefined), `${TODAY} 記録なし`);
    assert.equal(overallCellLabel(TODAY, [check], new Map()), `${TODAY} 記録なし`);
    assert.equal(habitCellLabel(minutes, TODAY, undefined), `${TODAY} 記録なし`);
  });

  it("says 記録なし when the day's only record belongs to a deleted habit", () => {
    // `indexEntries` keeps every entry, archived habits included, so the map for
    // such a day is non-empty while no *listed* habit has a value in it. The
    // paint and the name have to agree about that, or a blank-looking cell
    // announces "0 / 1 習慣 達成".
    const values = new Map([[999, 1]]);

    assert.equal(overallLevel([check], values), 0);
    assert.equal(overallCellLabel(TODAY, [check], values), `${TODAY} 記録なし`);
  });

  it("counts a day that has both a listed and a deleted habit's record", () => {
    const values = new Map([
      [check.id, 1],
      [999, 1],
    ]);

    assert.equal(overallCellLabel(TODAY, [check, minutes], values), `${TODAY} 1 / 2 習慣 達成`);
  });

  it("says 記録なし when there are no listed habits at all", () => {
    assert.equal(overallLevel([], new Map([[check.id, 1]])), 0);
    assert.equal(overallCellLabel(TODAY, [], new Map([[check.id, 1]])), `${TODAY} 記録なし`);
  });

  it("carries the value, the goal and the unit for a numeric habit", () => {
    assert.equal(habitCellLabel(minutes, TODAY, 12), `${TODAY} 12 / 30 分 未達成`);
    assert.equal(habitCellLabel(minutes, TODAY, 30), `${TODAY} 30 / 30 分 達成`);
    assert.equal(habitCellLabel(untargeted, TODAY, 5), `${TODAY} 5 ページ 達成`);
  });

  it("carries only the state for a check habit", () => {
    assert.equal(habitCellLabel(check, TODAY, 1), `${TODAY} 達成`);
    assert.equal(habitCellLabel(check, TODAY, 0), `${TODAY} 未達成`);
  });
});
