import type { Achievable } from "../../shared/domain.ts";
import { addDays, isAchieved, isISODate } from "../../shared/domain.ts";
import type { HabitStats } from "../../shared/types.ts";

/**
 * Streaks and achievement rates.
 *
 * Everything here is a pure function of (habit, records, today). No clock, no
 * database: `today` arrives as a `YYYY-MM-DD` string that the client decided
 * (docs/design.md), which is what makes these functions testable at all — and
 * what keeps the answer independent of the server's time zone.
 *
 * Two rules this file must not break:
 *
 *  1. **Achievement is `isAchieved()` and nothing else.** A `value >= target`
 *     written here would be a second definition of "done", and the day the two
 *     drift apart the screen says 達成 while the streak stays flat.
 *  2. **An unfinished today does not reset the current streak.** If today has no
 *     achievement yet we start counting from yesterday, because the user still
 *     has the rest of the day. Counting strictly from today would show 0 every
 *     morning, which is the opposite of what a habit app is for.
 */

/** Days in the achievement-rate window: today plus the 29 days before it. */
export const RATE_WINDOW_DAYS = 30;

/** One day's record. Deliberately narrower than `Entry` so tests can pass literals. */
export type DatedValue = {
  /** `YYYY-MM-DD`. */
  date: string;
  value: number;
};

/** A habit reduced to what statistics need: an id and the achievement rule. */
export type StatsHabit = Achievable & { id: number };

/** A record that still knows which habit it belongs to. */
export type HabitDatedValue = DatedValue & { habit_id: number };

/**
 * The set of days this habit counts as achieved, up to and including `today`.
 *
 * Records dated after `today` are ignored rather than trusted: a value written
 * for tomorrow (a client with a skewed clock, a manual API call) must not extend
 * a streak into days that have not happened.
 */
function achievedDates(
  habit: Achievable,
  records: readonly DatedValue[],
  today: string,
): Set<string> {
  const achieved = new Set<string>();

  for (const record of records) {
    // ISO dates compare correctly as strings, which is the whole reason the
    // app stores them this way.
    if (!isISODate(record.date) || record.date > today) continue;
    if (isAchieved(habit, record.value)) achieved.add(record.date);
  }

  return achieved;
}

/**
 * Length of the unbroken run ending today, or — when today is not achieved yet —
 * ending yesterday. 0 when neither day is achieved.
 */
function currentStreak(achieved: ReadonlySet<string>, today: string): number {
  // The one line that AC-4.2 is about: an unfinished today is not a broken day.
  let cursor = achieved.has(today) ? today : addDays(today, -1);

  let streak = 0;
  // Terminates: `cursor` strictly decreases and `achieved` is finite.
  while (achieved.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  return streak;
}

/** Longest unbroken run anywhere in the record, up to and including today. */
function longestStreak(achieved: ReadonlySet<string>): number {
  // `YYYY-MM-DD` sorts chronologically as plain text.
  const days = [...achieved].sort();

  let longest = 0;
  let run = 0;
  let previous: string | null = null;

  for (const day of days) {
    run = previous !== null && addDays(previous, 1) === day ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = day;
  }

  return longest;
}

/**
 * Achieved days within the last `RATE_WINDOW_DAYS` days.
 *
 * The denominator is the **window**, not the habit's age: "直近 30 日の達成率"
 * is a question about the last 30 days, and a fixed denominator is the only one
 * a reader can verify from the two numbers shown next to it. (It is also the only
 * one that survives a pinned clock: `habits.created_at` is a server wall-clock
 * timestamp, unrelated to the calendar day the client is asking about.)
 */
function windowAchievements(achieved: ReadonlySet<string>, today: string): number {
  const start = addDays(today, -(RATE_WINDOW_DAYS - 1));

  let days = 0;
  for (const day of achieved) {
    if (day >= start && day <= today) days += 1;
  }

  return days;
}

/**
 * Statistics for one habit. `records` may hold any dates in any order, including
 * days that are not achieved — those are what break a streak.
 */
export function computeHabitStats(
  habit: StatsHabit,
  records: readonly DatedValue[],
  today: string,
): HabitStats {
  if (!isISODate(today)) {
    throw new RangeError(`computeHabitStats: today must be YYYY-MM-DD, got ${JSON.stringify(today)}`);
  }

  const achieved = achievedDates(habit, records, today);
  const achievedDays = windowAchievements(achieved, today);

  return {
    habit_id: habit.id,
    current_streak: currentStreak(achieved, today),
    longest_streak: longestStreak(achieved),
    achieved_days: achievedDays,
    window_days: RATE_WINDOW_DAYS,
    achievement_rate: achievedDays / RATE_WINDOW_DAYS,
  };
}

/**
 * Statistics for every habit, in the order given. Records are bucketed by
 * `habit_id`; a habit with no records at all still gets a row of zeroes rather
 * than being left out (AC-4.4).
 */
export function computeStats(
  habits: readonly StatsHabit[],
  records: readonly HabitDatedValue[],
  today: string,
): HabitStats[] {
  const byHabit = new Map<number, DatedValue[]>();
  for (const habit of habits) byHabit.set(habit.id, []);

  for (const record of records) {
    // Records of habits we were not asked about (archived ones, for instance)
    // are skipped rather than creating a bucket nobody reads.
    byHabit.get(record.habit_id)?.push({ date: record.date, value: record.value });
  }

  return habits.map((habit) => computeHabitStats(habit, byHabit.get(habit.id) ?? [], today));
}
