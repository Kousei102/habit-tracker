import { useCallback, useEffect, useState } from "react";
import type { HabitStats } from "../../../shared/types.ts";
import * as store from "../data/store.ts";
import { describeError } from "../errors.ts";

/**
 * Streaks and the 30 day achievement rate for a given day.
 *
 * `today` is passed in rather than read here for the same reason it is in
 * `useHabits`: the browser's calendar day is decided once, in the Dashboard, and
 * everything below shares that one answer.
 *
 * `reload` is exposed because a stat is a function of the records — ticking a
 * habit changes the streak, so whoever performs the write is responsible for
 * asking for fresh numbers. The read is synchronous, so there is no longer any
 * way for two of them to overlap and land out of order.
 */

export type StatsStatus = "loading" | "ready" | "error";

export type UseStats = {
  /** Keyed by habit id, so a row can look up its own numbers. */
  byHabit: Record<number, HabitStats>;
  status: StatsStatus;
  /** Set only while `status` is "error"; never swallowed silently (AC-7.12). */
  error: string | null;
  reload: () => void;
};

export function useStats(today: string): UseStats {
  const [byHabit, setByHabit] = useState<Record<number, HabitStats>>({});
  const [status, setStatus] = useState<StatsStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    try {
      const stats = store.getStats(today);

      const next: Record<number, HabitStats> = {};
      for (const habitStats of stats) next[habitStats.habit_id] = habitStats;

      setByHabit(next);
      setError(null);
      setStatus("ready");
    } catch (cause) {
      // Shown rather than left as an empty panel: zeroes that are actually a
      // failure look exactly like a user who has done nothing.
      setError(describeError(cause, "データを読み込めませんでした"));
      setStatus("error");
    }
  }, [today]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { byHabit, status, error, reload };
}
