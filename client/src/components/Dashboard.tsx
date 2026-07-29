import { useMemo, useState } from "react";
import { heatmapStart } from "../../../shared/heatmap.ts";
import type { CreateHabitInput, Habit, UpdateHabitInput } from "../../../shared/types.ts";
import { describeError } from "../errors.ts";
import { useEntryHistory } from "../hooks/useEntryHistory.ts";
import { useHabits } from "../hooks/useHabits.ts";
import { useStats } from "../hooks/useStats.ts";
import { useToday } from "../hooks/useToday.ts";
import { HabitForm } from "./HabitForm.tsx";
import { HeatmapPanel } from "./HeatmapPanel.tsx";
import { StatsPanel } from "./StatsPanel.tsx";
import { TodayPanel } from "./TodayPanel.tsx";

/**
 * The app: today's habits, the numbers, the year, and the form that maintains
 * them.
 *
 * **This is where "today" enters the app.** `useToday` reads the browser's
 * calendar day (and keeps it current across midnight); everything below receives
 * it as a `YYYY-MM-DD` string.
 *
 * There is no sign-in any more (Phase 7): the data is in this browser and there
 * is no server to authenticate against, so a login screen would only be theatre.
 */
export function Dashboard() {
  const today = useToday();
  const {
    habits,
    archivedHabits,
    values,
    status,
    error,
    createHabit,
    updateHabit,
    deleteHabit,
    restoreHabit,
    setValue,
  } = useHabits(today);
  const stats = useStats(today);
  // The heatmap's window is decided here too, from the same "today".
  //
  // Memoised on `today` rather than recomputed inline. The value is a string, so
  // a fresh call would compare equal and not re-read on its own — but it is the
  // dependency of a read that now has a reason to change, and "the argument to an
  // effect's dependency is recomputed every render" is one edit away from a loop.
  const heatmapFrom = useMemo(() => heatmapStart(today), [today]);
  const history = useEntryHistory(heatmapFrom, today);

  /**
   * Every streak and rate is a function of the records, so any write invalidates
   * them. Refreshing here keeps the panel honest without each component having to
   * know about the other.
   *
   * Deliberately not allowed to fail the write it follows: the tick did land, and
   * the panel shows its own error if the numbers cannot be recomputed.
   */
  function refreshStats(): void {
    try {
      stats.reload();
    } catch {
      // useStats already turned this into visible state.
    }
  }

  /** The habit currently open in the form, or null while creating a new one. */
  const [editing, setEditing] = useState<Habit | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The habit deleted a moment ago, kept so the click can be taken back. */
  const [undoable, setUndoable] = useState<Habit | null>(null);

  function handleCreate(input: CreateHabitInput): Habit {
    setActionError(null);
    setUndoable(null);
    // Errors are deliberately not caught here — the form shows them next to the
    // fields the user just filled in.
    const created = createHabit(input);
    refreshStats();
    return created;
  }

  function handleUpdate(id: number, patch: UpdateHabitInput): Habit {
    setActionError(null);
    setUndoable(null);
    const updated = updateHabit(id, patch);
    // Only leave edit mode once the change actually landed.
    setEditing(null);
    // A new target changes which past days count as achieved.
    refreshStats();
    return updated;
  }

  /**
   * Deletes a habit and offers the click back.
   *
   * There is no confirmation dialog on purpose: the delete is logical, the habit
   * and its entries survive it, and a modal the user did not ask for costs
   * everybody a click to save one person a mistake. That trade only works if the
   * mistake is actually recoverable *from the screen*, which is what the undo
   * below is for.
   */
  function handleDelete(habit: Habit): void {
    setActionError(null);
    try {
      deleteHabit(habit.id);
      if (editing?.id === habit.id) setEditing(null);
      setUndoable(habit);
      refreshStats();
    } catch (cause) {
      setActionError(describeError(cause, "習慣を削除できませんでした"));
    }
  }

  function handleUndoDelete(habit: Habit): void {
    setActionError(null);
    try {
      restoreHabit(habit.id);
      setUndoable(null);
      refreshStats();
    } catch (cause) {
      setActionError(describeError(cause, "習慣を元に戻せませんでした"));
    }
  }

  /** Records the day's value, then recomputes the streaks it just changed. */
  function handleSetValue(habitId: number, value: number): void {
    const entry = setValue(habitId, value);
    // The heatmap holds a year of records; the one that just changed is handed
    // to it directly rather than re-read.
    history.applyEntry(entry);
    refreshStats();
  }

  return (
    <>
      <section className="card" aria-labelledby="dashboard-heading">
        <div className="dashboard__header">
          <h2 className="card__title" id="dashboard-heading">
            ダッシュボード
          </h2>
        </div>
        {actionError !== null && (
          <p className="form__error" role="alert">
            {actionError}
          </p>
        )}

        {/* Deliberately not role="alert"/"status": nothing failed, and a live
            region announcing every deletion would talk over the user. The undo
            is a button with its own name, so it is reachable by role either
            way. */}
        {undoable !== null && (
          <p className="undo" data-testid="undo-delete">
            <span>「{undoable.name}」を削除しました。記録は残っています。</span>
            <button
              className="button button--quiet button--small"
              type="button"
              onClick={() => handleUndoDelete(undoable)}
            >
              削除を取り消す
            </button>
            <button
              className="button button--quiet button--small"
              type="button"
              aria-label="削除の通知を閉じる"
              onClick={() => setUndoable(null)}
            >
              閉じる
            </button>
          </p>
        )}
      </section>

      <TodayPanel
        today={today}
        habits={habits}
        values={values}
        status={status}
        error={error}
        onSetValue={handleSetValue}
        onEdit={setEditing}
        onDelete={handleDelete}
      />

      <StatsPanel
        today={today}
        habits={habits}
        byHabit={stats.byHabit}
        status={stats.status}
        error={stats.error}
      />

      <HeatmapPanel
        today={today}
        habits={habits}
        archivedHabits={archivedHabits}
        entries={history.entries}
        status={history.status}
        error={history.error}
      />

      <HabitForm
        habit={editing}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        onCancelEdit={() => setEditing(null)}
      />
    </>
  );
}
