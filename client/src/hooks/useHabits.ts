import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateHabitRequest, Entry, Habit, UpdateHabitRequest } from "../../../shared/types.ts";
import * as api from "../api.ts";

/**
 * Loads the habits and the day's records, and owns every write that changes
 * them.
 *
 * The `today` argument is a `YYYY-MM-DD` string the caller derived from the
 * browser clock. Passing it in (rather than reading `new Date()` here) keeps the
 * "what day is it" decision in exactly one place on the client, and mirrors the
 * server rule that a date is always data, never something inferred.
 *
 * Mutations reject on failure instead of swallowing the error: the component
 * that triggered the write is the one that knows where to show it.
 */

export type HabitsStatus = "loading" | "ready" | "error";

export type UseHabits = {
  habits: Habit[];
  /**
   * The deleted (archived) habits, newest list order.
   *
   * Loaded from the same response as `habits`, not a second request. Only the
   * heatmap uses them: their records are kept by design, and a year of history
   * with no name against it is history the user cannot read.
   */
  archivedHabits: Habit[];
  /** Today's saved value per habit id. A missing id means "no record yet". */
  values: Record<number, number>;
  status: HabitsStatus;
  /** Set only when the initial load failed; mutation errors are thrown instead. */
  error: string | null;
  reload: () => Promise<void>;
  createHabit: (input: CreateHabitRequest) => Promise<Habit>;
  updateHabit: (id: number, patch: UpdateHabitRequest) => Promise<Habit>;
  deleteHabit: (id: number) => Promise<void>;
  /** Undo of `deleteHabit`: the habit returns to the list with its records. */
  restoreHabit: (id: number) => Promise<Habit>;
  /**
   * Upserts today's value and folds the server's answer back into `values`.
   *
   * Returns that answer so the caller can hand it to anything else holding
   * records — the heatmap's cached year, in particular, which would otherwise
   * have to re-read every entry after each keystroke.
   */
  setValue: (habitId: number, value: number) => Promise<Entry>;
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toValueMap(entries: Entry[]): Record<number, number> {
  const values: Record<number, number> = {};
  for (const entry of entries) values[entry.habit_id] = entry.value;
  return values;
}

export function useHabits(today: string): UseHabits {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [archivedHabits, setArchivedHabits] = useState<Habit[]>([]);
  const [values, setValues] = useState<Record<number, number>>({});
  const [status, setStatus] = useState<HabitsStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  // A response that arrives after unmount must not call setState.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      // One day's window: the panel only ever shows today. The heatmap will ask
      // for a wider range of its own.
      //
      // Archived habits ride along in the same response and are split out here,
      // so the today list stays exactly what it was while the heatmap gains the
      // names it needs. One request, one loading state, one error path.
      const [habitList, entries] = await Promise.all([api.getHabits(true), api.getEntries(today, today)]);
      if (!mounted.current) return;
      setHabits(habitList.filter((habit) => habit.archived_at === null));
      setArchivedHabits(habitList.filter((habit) => habit.archived_at !== null));
      setValues(toValueMap(entries));
      setError(null);
      setStatus("ready");
    } catch (cause) {
      if (!mounted.current) return;
      // A 401 is already handled globally in api.ts (back to the login screen);
      // anything else has to be visible rather than a permanent spinner.
      setError(messageOf(cause));
      setStatus("error");
    }
  }, [today]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createHabit = useCallback(
    async (input: CreateHabitRequest): Promise<Habit> => {
      const created = await api.createHabit(input);
      await reload();
      return created;
    },
    [reload],
  );

  const updateHabit = useCallback(
    async (id: number, patch: UpdateHabitRequest): Promise<Habit> => {
      const updated = await api.updateHabit(id, patch);
      await reload();
      return updated;
    },
    [reload],
  );

  const deleteHabit = useCallback(
    async (id: number): Promise<void> => {
      await api.deleteHabit(id);
      await reload();
    },
    [reload],
  );

  const restoreHabit = useCallback(
    async (id: number): Promise<Habit> => {
      const restored = await api.restoreHabit(id);
      await reload();
      return restored;
    },
    [reload],
  );

  const setValue = useCallback(
    async (habitId: number, value: number): Promise<Entry> => {
      // The stored value comes back from the server, so what the screen shows as
      // saved is what was actually written — not what we hoped to write.
      const entry = await api.putEntry(habitId, today, value);
      if (mounted.current) setValues((current) => ({ ...current, [entry.habit_id]: entry.value }));
      return entry;
    },
    [today],
  );

  return {
    habits,
    archivedHabits,
    values,
    status,
    error,
    reload,
    createHabit,
    updateHabit,
    deleteHabit,
    restoreHabit,
    setValue,
  };
}
