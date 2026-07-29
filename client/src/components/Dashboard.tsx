import { useMemo, useState } from "react";
import { heatmapStart } from "../../../shared/heatmap.ts";
import type { CreateHabitRequest, Habit, SessionUser, UpdateHabitRequest } from "../../../shared/types.ts";
import { logout } from "../api.ts";
import { describeError } from "../errors.ts";
import { useEntryHistory } from "../hooks/useEntryHistory.ts";
import { useHabits } from "../hooks/useHabits.ts";
import { useStats } from "../hooks/useStats.ts";
import { useToday } from "../hooks/useToday.ts";
import { HabitForm } from "./HabitForm.tsx";
import { HeatmapPanel } from "./HeatmapPanel.tsx";
import { StatsPanel } from "./StatsPanel.tsx";
import { TodayPanel } from "./TodayPanel.tsx";

type DashboardProps = {
  user: SessionUser;
  onLoggedOut: () => void;
};

/**
 * The signed-in view: who is here, today's habits, and the form that maintains
 * them.
 *
 * **This is where "today" enters the app.** `useToday` reads the browser's
 * calendar day (and keeps it current across midnight); everything below receives
 * it as a `YYYY-MM-DD` string and no server code ever derives a date
 * (docs/design.md §1).
 */
export function Dashboard({ user, onLoggedOut }: DashboardProps) {
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
  // The heatmap's window is decided here too, from the same "today": the server
  // is told both ends as strings and never works out a range of its own.
  //
  // Memoised on `today` rather than recomputed inline. The value is a string, so
  // a fresh call would compare equal and not refetch on its own — but it is the
  // dependency of a fetch that now has a reason to change, and "the argument to
  // an effect's dependency is recomputed every render" is one edit away from a
  // request loop. Tying it to the only input it has removes the question.
  const heatmapFrom = useMemo(() => heatmapStart(today), [today]);
  const history = useEntryHistory(heatmapFrom, today);

  /**
   * Every streak and rate is a function of the records, so any write invalidates
   * them. Refreshing here — after the write the component already awaits — keeps
   * the panel honest without each component having to know about the other.
   *
   * The reload is deliberately not allowed to fail the write it follows: the tick
   * did land, and the panel shows its own error if the numbers cannot be fetched.
   */
  async function refreshStats(): Promise<void> {
    try {
      await stats.reload();
    } catch {
      // useStats already turned this into visible state.
    }
  }

  /** The habit currently open in the form, or null while creating a new one. */
  const [editing, setEditing] = useState<Habit | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The habit deleted a moment ago, kept so the click can be taken back. */
  const [undoable, setUndoable] = useState<Habit | null>(null);

  /**
   * Signs out — and, when that fails, says so instead of pretending.
   *
   * Dropping to the login screen on a failed logout used to look tidier, but it
   * is a lie the very next reload contradicts: the session is still valid, so
   * `/api/auth/me` answers 200 and the dashboard comes straight back. Staying
   * here with a visible error is both honest and actionable — the button can be
   * pressed again (AC-6.4).
   */
  async function handleLogout(): Promise<void> {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      await logout();
      onLoggedOut();
    } catch (cause) {
      setActionError(describeError(cause, "ログアウトできませんでした"));
    } finally {
      setPending(false);
    }
  }

  async function handleCreate(input: CreateHabitRequest): Promise<Habit> {
    setActionError(null);
    setUndoable(null);
    // Errors are deliberately not caught here — the form shows them next to the
    // fields the user just filled in.
    const created = await createHabit(input);
    await refreshStats();
    return created;
  }

  async function handleUpdate(id: number, patch: UpdateHabitRequest): Promise<Habit> {
    setActionError(null);
    setUndoable(null);
    const updated = await updateHabit(id, patch);
    // Only leave edit mode once the change actually landed.
    setEditing(null);
    // A new target changes which past days count as achieved.
    await refreshStats();
    return updated;
  }

  /**
   * Deletes a habit and offers the click back.
   *
   * There is no confirmation dialog on purpose: the delete is logical, the row
   * and its entries survive it, and a modal the user did not ask for costs
   * everybody a click to save one person a mistake. That trade only works if the
   * mistake is actually recoverable *from the screen*, which is what the undo
   * below is for — the database has always been able to do it.
   */
  async function handleDelete(habit: Habit): Promise<void> {
    setActionError(null);
    try {
      await deleteHabit(habit.id);
      if (editing?.id === habit.id) setEditing(null);
      setUndoable(habit);
      await refreshStats();
    } catch (cause) {
      setActionError(describeError(cause, "習慣を削除できませんでした"));
    }
  }

  async function handleUndoDelete(habit: Habit): Promise<void> {
    setActionError(null);
    try {
      await restoreHabit(habit.id);
      setUndoable(null);
      await refreshStats();
    } catch (cause) {
      setActionError(describeError(cause, "習慣を元に戻せませんでした"));
    }
  }

  /** Records the day's value, then re-asks for the streaks it just changed. */
  async function handleSetValue(habitId: number, value: number): Promise<void> {
    const entry = await setValue(habitId, value);
    // The heatmap holds a year of records; the one that just changed is handed
    // to it directly rather than re-read, so a write costs one request, not two.
    history.applyEntry(entry);
    await refreshStats();
  }

  return (
    <>
      <section className="card" aria-labelledby="dashboard-heading">
        <div className="dashboard__header">
          <h2 className="card__title" id="dashboard-heading">
            ダッシュボード
          </h2>
          <button className="button button--quiet" type="button" onClick={handleLogout} disabled={pending}>
            ログアウト
          </button>
        </div>
        <p className="dashboard__user" data-testid="current-user">
          {user.username} としてログイン中
        </p>
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
              onClick={() => void handleUndoDelete(undoable)}
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
