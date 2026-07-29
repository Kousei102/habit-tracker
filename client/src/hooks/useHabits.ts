import { useCallback, useEffect, useState } from "react";
import type { CreateHabitInput, Entry, Habit, UpdateHabitInput } from "../../../shared/types.ts";
import * as store from "../data/store.ts";
import { describeError } from "../errors.ts";

/**
 * Loads the habits and the day's records, and owns every write that changes
 * them.
 *
 * The `today` argument is a `YYYY-MM-DD` string the caller derived from the
 * browser clock. Passing it in (rather than reading `new Date()` here) keeps the
 * "what day is it" decision in exactly one place.
 *
 * **Everything here is synchronous.** The store is `localStorage`, which answers
 * immediately (AC-7.5); there is no in-flight state to track and no response that
 * can arrive after the component is gone. Mutations throw on failure instead of
 * swallowing the error: the component that triggered the write is the one that
 * knows where to show it.
 */

export type HabitsStatus = "loading" | "ready" | "error";

export type UseHabits = {
  habits: Habit[];
  /**
   * The deleted (archived) habits, in list order.
   *
   * Read in the same pass as `habits`. Only the heatmap uses them: their records
   * are kept by design, and a year of history with no name against it is history
   * the user cannot read.
   */
  archivedHabits: Habit[];
  /** Today's saved value per habit id. A missing id means "no record yet". */
  values: Record<number, number>;
  status: HabitsStatus;
  /** Set only when the load failed; mutation errors are thrown instead. */
  error: string | null;
  reload: () => void;
  createHabit: (input: CreateHabitInput) => Habit;
  updateHabit: (id: number, patch: UpdateHabitInput) => Habit;
  deleteHabit: (id: number) => void;
  /** Undo of `deleteHabit`: the habit returns to the list with its records. */
  restoreHabit: (id: number) => Habit;
  /**
   * Records today's value and folds the stored result back into `values`.
   *
   * Returns that result so the caller can hand it to anything else holding
   * records — the heatmap's cached year, in particular.
   */
  setValue: (habitId: number, value: number) => Entry;
};

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

  const reload = useCallback(() => {
    try {
      // One day's window: the panel only ever shows today. The heatmap asks for
      // a wider range of its own.
      //
      // Archived habits come back in the same read and are split out here, so
      // the today list stays exactly what it was while the heatmap gains the
      // names it needs.
      const habitList = store.getHabits(true);
      const entries = store.getEntries(today, today);

      setHabits(habitList.filter((habit) => habit.archived_at === null));
      setArchivedHabits(habitList.filter((habit) => habit.archived_at !== null));
      setValues(toValueMap(entries));
      setError(null);
      setStatus("ready");
    } catch (cause) {
      // An unreadable document is the main way this fails (AC-7.6). It has to be
      // visible rather than a permanent spinner, and it must not be treated as
      // "no habits yet" — that would invite the user to recreate everything on
      // top of data that is still there.
      setError(describeError(cause, "データを読み込めませんでした"));
      setStatus("error");
    }
  }, [today]);

  useEffect(() => {
    reload();
  }, [reload]);

  const createHabit = useCallback(
    (input: CreateHabitInput): Habit => {
      const created = store.createHabit(input);
      reload();
      return created;
    },
    [reload],
  );

  const updateHabit = useCallback(
    (id: number, patch: UpdateHabitInput): Habit => {
      const updated = store.updateHabit(id, patch);
      reload();
      return updated;
    },
    [reload],
  );

  const deleteHabit = useCallback(
    (id: number): void => {
      store.deleteHabit(id);
      reload();
    },
    [reload],
  );

  const restoreHabit = useCallback(
    (id: number): Habit => {
      const restored = store.restoreHabit(id);
      reload();
      return restored;
    },
    [reload],
  );

  const setValue = useCallback(
    (habitId: number, value: number): Entry => {
      // The stored value comes back from the store, so what the screen shows as
      // saved is what was actually written — not what we hoped to write.
      const entry = store.putEntry(habitId, today, value);
      setValues((current) => ({ ...current, [entry.habit_id]: entry.value }));
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
