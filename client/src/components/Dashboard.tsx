import { useEffect, useState } from "react";
import type { SessionUser } from "../../../shared/types.ts";
import { getHabits, logout } from "../api.ts";

type DashboardProps = {
  user: SessionUser;
  onLoggedOut: () => void;
};

/**
 * The signed-in view. Phase 2 only owns the shell (who is signed in, and the way
 * out); Phase 3 fills in today's habits.
 */
type HabitsState =
  | { status: "loading" }
  | { status: "ready"; count: number }
  | { status: "error"; message: string };

export function Dashboard({ user, onLoggedOut }: DashboardProps) {
  const [habits, setHabits] = useState<HabitsState>({ status: "loading" });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // A 401 here means the session died while the tab was open; api.ts routes
    // that back to the login screen, so there is nothing to handle locally.
    getHabits()
      .then((list) => {
        if (!cancelled) setHabits({ status: "ready", count: list.length });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setHabits({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
      </section>

      <section className="card" aria-labelledby="today-heading">
        <h2 className="card__title" id="today-heading">
          今日の習慣
        </h2>
        <HabitsSummary habits={habits} />
      </section>
    </>
  );
}

function HabitsSummary({ habits }: { habits: HabitsState }) {
  if (habits.status === "loading") return <p className="muted">読み込み中…</p>;

  // Failing loudly rather than showing a permanent "loading" (see AC-6.4).
  if (habits.status === "error") {
    return (
      <p className="form__error" role="alert">
        習慣を読み込めませんでした（{habits.message}）
      </p>
    );
  }

  if (habits.count === 0) return <p className="muted">習慣がまだ登録されていません。</p>;

  return <p className="muted">{habits.count} 件の習慣</p>;
}
