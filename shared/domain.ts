import type { Habit } from "./types.ts";

/**
 * Domain rules shared by client and server.
 *
 * Everything here is a pure function of its arguments — no clock, no database,
 * no DOM — so both sides can import it and `node:test` can cover it directly.
 */

/**
 * The part of a habit that decides whether a value counts as done. Narrower than
 * `Habit` so callers can pass a row, a form draft, or a test fixture.
 */
export type Achievable = Pick<Habit, "kind" | "target">;

/**
 * **The single definition of "done" in this app.**
 *
 *   boolean … value >= 1
 *   numeric … value >= target when a target is set, otherwise value > 0
 *
 * The display (client) and the streak/rate maths (server) must agree, and the
 * only way to guarantee that is for both to call this. Writing the same
 * comparison a second time anywhere is the bug this function exists to prevent:
 * fix one copy and the screen says "achieved" while the streak stays at zero.
 *
 * A non-finite value (NaN from a half-typed input) is never an achievement.
 */
export function isAchieved(habit: Achievable, value: number): boolean {
  if (!Number.isFinite(value)) return false;

  if (habit.kind === "boolean") return value >= 1;

  // A target of null/0/negative is treated as "no target": a goal of zero is not
  // something a user can miss, so falling back to "did anything at all" is the
  // only reading that keeps the habit trackable.
  const target = habit.target;
  if (target !== null && Number.isFinite(target) && target > 0) return value >= target;

  return value > 0;
}

/** Strict `YYYY-MM-DD`. Anchored, so no prefix/suffix sneaks through. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a `YYYY-MM-DD` string that is also a real calendar day.
 *
 * The pattern alone would accept `2026-02-31`; round-tripping through UTC
 * rejects it, and UTC is safe here precisely because the string carries no time.
 */
export function isISODate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Formats a `Date` as `YYYY-MM-DD` using its **local** calendar fields.
 *
 * This is how the client answers "what day is it", and it is the one place the
 * clock is read at all (see docs/design.md: the server never derives a date).
 * `toISOString().slice(0, 10)` would be wrong here — at 09:00 JST it still says
 * yesterday, which is exactly the class of bug this design avoids.
 */
export function toISODate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Shifts a `YYYY-MM-DD` string by whole days.
 *
 * Computed in UTC on purpose: a date string has no time zone, and doing the
 * arithmetic in local time would make `addDays(d, -1)` land on the same day
 * across a DST boundary.
 */
export function addDays(date: string, days: number): string {
  if (!isISODate(date)) throw new RangeError(`addDays: expected YYYY-MM-DD, got ${JSON.stringify(date)}`);

  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  const y = String(shifted.getUTCFullYear()).padStart(4, "0");
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Renders a stored value for display: `30` not `30.0`, `2.5` stays `2.5`.
 * Shared so the list, the form and the (later) heatmap tooltip agree.
 */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 1000) / 1000);
}
