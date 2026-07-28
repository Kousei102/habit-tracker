import { useCallback, useEffect, useRef, useState } from "react";
import type { HabitStats } from "../../../shared/types.ts";
import * as api from "../api.ts";

/**
 * Loads `GET /api/stats` for a given day.
 *
 * `today` is passed in rather than read here for the same reason it is in
 * `useHabits`: the browser's calendar day is decided once, in the Dashboard, and
 * everything below shares that one answer.
 *
 * `reload` is exposed because a stat is a function of the records — ticking a
 * habit changes the streak, so whoever performs the write is responsible for
 * asking for fresh numbers.
 */

export type StatsStatus = "loading" | "ready" | "error";

export type UseStats = {
  /** Keyed by habit id, so a row can look up its own numbers. */
  byHabit: Record<number, HabitStats>;
  status: StatsStatus;
  /** Set only while `status` is "error"; never swallowed silently (AC-6.4). */
  error: string | null;
  reload: () => Promise<void>;
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useStats(today: string): UseStats {
  const [byHabit, setByHabit] = useState<Record<number, HabitStats>>({});
  const [status, setStatus] = useState<StatsStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  // A response that arrives after unmount must not call setState.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Typing into a numeric field fires a write (and a reload) per keystroke, so
  // two answers can be in flight at once. Only the newest one may be applied —
  // otherwise a slow early response overwrites the streak with a stale number.
  const latestRequest = useRef(0);

  const reload = useCallback(async () => {
    const request = (latestRequest.current += 1);

    try {
      const response = await api.getStats(today);
      if (!mounted.current || request !== latestRequest.current) return;

      const next: Record<number, HabitStats> = {};
      for (const stats of response.stats) next[stats.habit_id] = stats;

      setByHabit(next);
      setError(null);
      setStatus("ready");
    } catch (cause) {
      if (!mounted.current || request !== latestRequest.current) return;
      // A 401 already sends the app back to the login screen (api.ts); anything
      // else has to be shown rather than left as an empty panel.
      setError(messageOf(cause));
      setStatus("error");
    }
  }, [today]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { byHabit, status, error, reload };
}
