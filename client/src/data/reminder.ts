import type { Habit } from "../../../shared/types.ts";
import { isAchieved } from "../../../shared/domain.ts";

/**
 * What the app has to say about today, and what number belongs on the icon.
 *
 * Pure functions of their arguments, like `document.ts` and `backup.ts`: no
 * clock, no storage, no DOM. The clock in particular stays out — "today" was
 * already decided by `hooks/useToday.ts` and reaches here only as the caller's
 * choice of which day's `values` to pass in.
 *
 * This module exists because the alternative is a component that counts habits
 * inline, and counting is exactly the thing that must not be duplicated: the
 * badge, the sentence on screen and the streak maths all have to agree about the
 * word "done". They agree by all of them calling `isAchieved()`.
 */

/**
 * The habits that are not done yet today, in the order they were given.
 *
 * A habit with no record at all is not done. That falls out of `isAchieved()`
 * rather than being decided here: a missing value becomes 0, and 0 fails every
 * branch of the rule (`>= 1`, `>= target`, `> 0`). Writing "no entry means
 * pending" as its own condition would be a second definition of done, which is
 * the bug docs/design.md §2 exists to prevent.
 *
 * Archived habits are the caller's problem — `useHabits` already hands out the
 * listed ones separately, and a deleted habit must never be nagged about.
 */
export function pendingHabits(habits: Habit[], values: Record<number, number>): Habit[] {
  return habits.filter((habit) => !isAchieved(habit, values[habit.id] ?? 0));
}

/**
 * The number for the app icon.
 *
 * Trivial today, and named anyway: the badge and the sentence must never be able
 * to disagree, and the way to guarantee that is for both to come from here.
 */
export function badgeCount(pending: Habit[]): number {
  return pending.length;
}

/** How many names to list before falling back to a count. */
const MAX_NAMES = 3;

/**
 * The sentence to put on screen, or `null` for "say nothing".
 *
 * Same rule as `exportReminder()` in `backup.ts`: an app that nags on every
 * visit gets its nagging ignored. With no habits there is nothing to be behind
 * on, so the panel stays silent rather than greeting a new user with a status
 * report about zero things.
 *
 * `habitCount` is the size of the list `pending` was filtered from. It is passed
 * separately because "all done" and "nothing to do" read identically from
 * `pending` alone, and they are not the same thing to a person.
 */
export function reminderMessage(pending: Habit[], habitCount: number): string | null {
  if (habitCount <= 0) return null;

  if (pending.length === 0) return "今日の習慣はすべて達成しています。";

  const names = pending.slice(0, MAX_NAMES).map((habit) => habit.name);
  const rest = pending.length - names.length;
  // Built here rather than in JSX: a line break inside JSX text becomes a space,
  // which puts stray gaps in Japanese sentences (see backup.ts for the same
  // reason).
  const listed = rest > 0 ? `${names.join(" / ")} ほか ${rest} 件` : names.join(" / ");

  return `今日はまだ ${pending.length} 件未達成です（${listed}）。`;
}
