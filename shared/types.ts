/**
 * The types the whole app is written against.
 *
 * They used to be "what crosses the wire" between client and server. There is no
 * wire any more (Phase 7): the data lives in the browser, so these are simply the
 * shapes the storage layer stores and the components read. The field names stay
 * snake_case — they were the SQLite columns, and keeping them means the Phase 8
 * export file reads the same as the database dump it replaces.
 */

/**
 * How a habit is recorded.
 *
 * A union of string literals rather than an `enum`: the project type-checks with
 * `erasableSyntaxOnly`, where `enum` would need codegen.
 */
export type HabitKind = "boolean" | "numeric";

/**
 * One habit.
 *
 * `archived_at` is the logical delete (docs/design.md §4): a deleted habit keeps
 * its id and all of its entries, it just stops being listed. Nothing in the app
 * ever removes an entry row.
 */
export type Habit = {
  id: number;
  name: string;
  kind: HabitKind;
  /** `numeric` only: the daily goal. Always null for `boolean`. */
  target: number | null;
  /** `numeric` only: '分', '回', … Always null for `boolean`. */
  unit: string | null;
  /** Palette key used by the heatmap. */
  color: string;
  sort_order: number;
  /** Set when the habit is archived (logical delete). Listed habits have null. */
  archived_at: string | null;
  created_at: string;
};

/** One day's record for one habit. `date` is always `YYYY-MM-DD`. */
export type Entry = {
  habit_id: number;
  date: string;
  /** `boolean` habits store 0/1; `numeric` habits store the amount done. */
  value: number;
};

/** What the form hands to the storage layer to create a habit. */
export type CreateHabitInput = {
  name: string;
  kind: HabitKind;
  /** Optional even for `numeric`: no goal means "any value above zero counts". */
  target?: number | null;
  unit?: string | null;
  color?: string;
};

/**
 * A partial edit of a habit. Omitted fields keep their stored value; an explicit
 * `null` target clears the goal. `kind` cannot be changed — past entries were
 * recorded in the old kind's terms.
 */
export type UpdateHabitInput = {
  name?: string;
  target?: number | null;
  unit?: string | null;
  color?: string;
};

/**
 * Streaks and achievement rate for one habit, as of a given day.
 *
 * The "given day" is always the `today` the browser decided (docs/design.md §1).
 * Both counts are in whole days.
 */
export type HabitStats = {
  habit_id: number;
  /**
   * Days achieved in an unbroken run ending today **or yesterday**: a day that
   * is not over yet must not reset the count (docs/design.md).
   */
  current_streak: number;
  /** Longest unbroken run ever recorded, up to and including today. */
  longest_streak: number;
  /** Achieved days inside the rate window. */
  achieved_days: number;
  /** Length of the rate window in days — today plus the 29 days before it. */
  window_days: number;
  /** `achieved_days / window_days`, between 0 and 1. */
  achievement_rate: number;
};
