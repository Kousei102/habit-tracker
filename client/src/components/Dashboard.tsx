import { useState } from "react";
import { toISODate } from "../../../shared/domain.ts";
import type { CreateHabitRequest, Habit, SessionUser, UpdateHabitRequest } from "../../../shared/types.ts";
import { ApiError, logout } from "../api.ts";
import { useHabits } from "../hooks/useHabits.ts";
import { useStats } from "../hooks/useStats.ts";
import { HabitForm } from "./HabitForm.tsx";
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
 * **This is where "today" is decided.** The browser's calendar day is read once,
 * on mount, and handed to everything below as a `YYYY-MM-DD` string; no server
 * code ever derives a date (docs/design.md). Reading it once also means the day
 * cannot change under a rendered list mid-session.
 */
export function Dashboard({ user, onLoggedOut }: DashboardProps) {
  const [today] = useState(() => toISODate(new Date()));
  const { habits, values, status, error, createHabit, updateHabit, deleteHabit, setValue } = useHabits(today);
  const stats = useStats(today);

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

  async function handleLogout(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      await logout();
    } finally {
      // Even if the request failed, the local session is over: the next API call
      // would 401 anyway, and leaving the user stuck on the dashboard is worse.
      onLoggedOut();
    }
  }

  async function handleCreate(input: CreateHabitRequest): Promise<Habit> {
    setActionError(null);
    // Errors are deliberately not caught here — the form shows them next to the
    // fields the user just filled in.
    const created = await createHabit(input);
    await refreshStats();
    return created;
  }

  async function handleUpdate(id: number, patch: UpdateHabitRequest): Promise<Habit> {
    setActionError(null);
    const updated = await updateHabit(id, patch);
    // Only leave edit mode once the change actually landed.
    setEditing(null);
    // A new target changes which past days count as achieved.
    await refreshStats();
    return updated;
  }

  async function handleDelete(habit: Habit): Promise<void> {
    setActionError(null);
    try {
      await deleteHabit(habit.id);
      if (editing?.id === habit.id) setEditing(null);
      await refreshStats();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : "習慣を削除できませんでした");
    }
  }

  /** Records the day's value, then re-asks for the streaks it just changed. */
  async function handleSetValue(habitId: number, value: number): Promise<void> {
    await setValue(habitId, value);
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

      <HabitForm
        habit={editing}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        onCancelEdit={() => setEditing(null)}
      />
    </>
  );
}
