import { addDays, formatValue, isAchieved } from "./domain.ts";
import type { Entry, Habit } from "./types.ts";

/**
 * The maths behind the year heatmap: which day sits in which cell, and how dark
 * that cell is.
 *
 * Pure functions of their arguments — no clock, no DOM, no fetch — for the same
 * reason the rest of `shared/` is: the grid is the piece most likely to be off
 * by a day, and `node:test` can only cover it if nothing here reads a clock.
 * "Today" always arrives as a `YYYY-MM-DD` string decided by the browser.
 *
 * **The top level is `isAchieved()` and nothing else.** A `value >= target`
 * written here would be a second definition of "done" that the streaks do not
 * share — the exact bug docs/design.md §2 forbids. Only the *intermediate*
 * shades use the raw ratio, and they never decide whether a day counts.
 */

/** Rows in the grid: one per weekday. */
export const HEATMAP_ROWS = 7;

/** Columns in the grid. 53 × 7 = 371 days ≈ "the last year" (AC-5.1). */
export const HEATMAP_COLUMNS = 53;

/** Total days drawn. The grid is a full rectangle: no ragged first column. */
export const HEATMAP_DAYS = HEATMAP_ROWS * HEATMAP_COLUMNS;

/**
 * 0 … no record at all for that day
 * 1 … recorded, but nothing (or almost nothing) achieved
 * 2–3 … partial progress towards the goal
 * 4 … achieved, as `isAchieved()` defines it
 */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** The first day drawn, given the last one. Inclusive of both ends. */
export function heatmapStart(today: string, days: number = HEATMAP_DAYS): string {
  return addDays(today, -(days - 1));
}

/**
 * The grid, column by column, oldest first. `grid[column][row]` is a
 * `YYYY-MM-DD` string and the last cell is always `today` (AC: the right edge is
 * the browser's today).
 *
 * The window is a whole number of weeks *counted back from today*, rather than
 * aligned to calendar Sundays. Both give 7 consistent weekday rows — 371 is a
 * multiple of 7, so every cell in a row is the same weekday — but only this one
 * fills the rectangle completely. Aligning to Sunday instead leaves the first
 * column ragged and the last column padded with days that have not happened yet,
 * and a cell for a future date has no honest value to announce.
 */
export function buildHeatmapGrid(today: string, days: number = HEATMAP_DAYS): string[][] {
  const start = heatmapStart(today, days);
  const columns: string[][] = [];

  for (let index = 0; index < days; index += 1) {
    const column = Math.floor(index / HEATMAP_ROWS);
    if (columns[column] === undefined) columns[column] = [];
    (columns[column] as string[]).push(addDays(start, index));
  }

  return columns;
}

/** 0 = Sunday … 6 = Saturday, read in UTC because a date string has no zone. */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const WEEKDAY_NAMES = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"] as const;

export function weekdayName(date: string): string {
  return WEEKDAY_NAMES[weekdayOf(date)] ?? "";
}

/** `2026-03-15` → `3` (1–12). */
export function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

/** A month label to draw above a column of the grid. */
export type MonthMark = {
  /** Index into the grid's columns. */
  column: number;
  /** 1–12. */
  month: number;
};

/**
 * Where the month labels go: one per month, at the column the month starts in.
 *
 * Two labels closer than `minGap` columns would overlap at 13px per column, so
 * one of them has to go — and *which* one matters. Deciding by looking backwards
 * ("skip this month if the previous label is too close") drops a real month
 * boundary and shifts the next label off the boundary it names. Deciding by
 * looking forwards drops only a label whose successor is right behind it, and
 * the only mark that can be in that position is the leading partial month: every
 * other pair of boundaries is at least 28 days — four columns — apart. So no
 * month ever loses its label; at most the sliver of month the grid opens with
 * goes unnamed, which is the honest one to lose since it is barely on screen.
 */
export function monthMarks(grid: readonly (readonly string[])[], minGap: number = 3): MonthMark[] {
  const changes: MonthMark[] = [];
  let previousMonth = -1;

  for (let column = 0; column < grid.length; column += 1) {
    const first = grid[column]?.[0];
    if (first === undefined || first === "") continue;

    const month = monthOf(first);
    if (month !== previousMonth) changes.push({ column, month });
    previousMonth = month;
  }

  return changes.filter((mark, index) => {
    const next = changes[index + 1];
    return next === undefined || next.column - mark.column >= minGap;
  });
}

/** Records indexed as `date → habit id → value`, which is how a cell asks. */
export type EntryIndex = Map<string, Map<number, number>>;

export function indexEntries(entries: readonly Entry[]): EntryIndex {
  const index: EntryIndex = new Map();

  for (const entry of entries) {
    let day = index.get(entry.date);
    if (day === undefined) {
      day = new Map();
      index.set(entry.date, day);
    }
    day.set(entry.habit_id, entry.value);
  }

  return index;
}

/**
 * Shade for one habit on one day.
 *
 * `undefined` means "no row in `entries`", which is not the same as a stored
 * zero: a day the user explicitly marked as not done is a day they turned up
 * for, and AC-5.2 asks for it to look different from a day with no record at
 * all. So a stored 0 is level 1, the faintest ink, never level 0.
 *
 * boolean habits therefore use two shades (1 = recorded, not done; 4 = done),
 * numeric habits four (the ratio to the goal, capped below 4 until the goal is
 * actually met — level 4 means `isAchieved()`, in this view and in the streaks).
 */
export function habitLevel(habit: Habit, value: number | undefined): HeatLevel {
  if (value === undefined || !Number.isFinite(value)) return 0;
  if (isAchieved(habit, value)) return 4;

  const target = habit.target;
  if (habit.kind === "numeric" && target !== null && Number.isFinite(target) && target > 0) {
    const ratio = value / target; // 0 <= ratio < 1: at 1 isAchieved() already returned 4
    if (ratio >= 0.66) return 3;
    if (ratio >= 0.33) return 2;
  }

  return 1;
}

/**
 * How many of the day's habits were recorded, and how many of those count.
 *
 * **The single source of "was anything recorded that day"**, so the shade and
 * the accessible name can never disagree. They used to: the level walked
 * `habits` while the label only asked whether the day's map was empty, and the
 * map is built from *every* entry — archived habits included. A day whose only
 * record belonged to a deleted habit was therefore painted as blank while
 * announcing "0 / 1 習慣 達成". Both now ask this function.
 *
 * Archived habits are not counted: they are not part of "how much of today did
 * I do" any more, and their entries are read through their own map instead.
 */
export type OverallCounts = {
  /** Habits in `habits` with a record on the day. */
  recorded: number;
  /** How many of those `isAchieved()` accepts. */
  achieved: number;
};

export function overallCounts(
  habits: readonly Habit[],
  values: ReadonlyMap<number, number> | undefined,
): OverallCounts {
  if (values === undefined) return { recorded: 0, achieved: 0 };

  let recorded = 0;
  let achieved = 0;

  for (const habit of habits) {
    const value = values.get(habit.id);
    if (value === undefined) continue;
    recorded += 1;
    if (isAchieved(habit, value)) achieved += 1;
  }

  return { recorded, achieved };
}

/**
 * Shade for the whole day: achieved habits over active habits, in four steps
 * (docs/design.md).
 *
 * `Math.ceil` over `max(1, …)` is what keeps AC-5.2 true for a day that was
 * recorded but achieved nothing: the ratio is 0, yet the day is not blank.
 */
export function overallLevel(habits: readonly Habit[], values: ReadonlyMap<number, number> | undefined): HeatLevel {
  if (habits.length === 0) return 0;

  const { recorded, achieved } = overallCounts(habits, values);
  if (recorded === 0) return 0;

  const step = Math.ceil((achieved / habits.length) * 4);
  return Math.min(4, Math.max(1, step)) as HeatLevel;
}

/** How many of the day's active habits were achieved — the label's numerator. */
export function achievedCount(habits: readonly Habit[], values: ReadonlyMap<number, number> | undefined): number {
  return overallCounts(habits, values).achieved;
}

/**
 * The cell's accessible name in the overall view (AC-5.4).
 *
 * The ISO date leads, so a reader — human or `getByRole` — always gets the day
 * before the number, and a spec can address one cell by its date alone.
 *
 * "Recorded" means the same thing here as it does for the paint: at least one
 * *listed* habit has a value. A day holding nothing but a deleted habit's record
 * is blank in both channels.
 */
export function overallCellLabel(
  date: string,
  habits: readonly Habit[],
  values: ReadonlyMap<number, number> | undefined,
): string {
  const { recorded, achieved } = overallCounts(habits, values);
  if (recorded === 0) return `${date} 記録なし`;
  return `${date} ${achieved} / ${habits.length} 習慣 達成`;
}

/** The same, for a single habit: the day, what was recorded, and whether it counts. */
export function habitCellLabel(habit: Habit, date: string, value: number | undefined): string {
  if (value === undefined) return `${date} 記録なし`;

  const state = isAchieved(habit, value) ? "達成" : "未達成";
  if (habit.kind === "boolean") return `${date} ${state}`;

  const unit = habit.unit === null || habit.unit === "" ? "" : ` ${habit.unit}`;
  const amount =
    habit.target === null
      ? `${formatValue(value)}${unit}`
      : `${formatValue(value)} / ${formatValue(habit.target)}${unit}`;

  return `${date} ${amount} ${state}`;
}
