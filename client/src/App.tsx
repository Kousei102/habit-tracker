import { useCallback, useEffect, useState } from "react";
import type { HealthResponse, SessionUser } from "../../shared/types.ts";
import { ApiError, getHealth, getMe, setUnauthorizedHandler } from "./api.ts";
import { describeError } from "./errors.ts";
import { Dashboard } from "./components/Dashboard.tsx";
import { LoginPage } from "./components/LoginPage.tsx";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; data: HealthResponse }
  | { status: "error"; message: string };

/**
 * Who is signed in. `checking` exists so a reload does not flash the login
 * screen before `/api/auth/me` answers — the session lives in an HttpOnly
 * cookie, so the client cannot know the answer without asking.
 */
type AuthState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: SessionUser };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  /**
   * Why the session check failed, when it failed for a reason other than "not
   * signed in".
   *
   * Without it, a broken or unreachable API looks exactly like a signed-out
   * user: the login form appears, the user types the right password, and the
   * only clue that anything is wrong is in the console (AC-6.4).
   */
  const [authError, setAuthError] = useState<string | null>(null);

  const goAnonymous = useCallback(() => {
    setAuth({ status: "anonymous" });
    // Reaching the login screen through a 401 is the ordinary end of a session,
    // not a fault to report.
    setAuthError(null);
  }, []);

  // Any API 401, from any screen, drops back to the login form.
  useEffect(() => {
    setUnauthorizedHandler(goAnonymous);
    return () => setUnauthorizedHandler(null);
  }, [goAnonymous]);

  useEffect(() => {
    let cancelled = false;

    getMe()
      .then(({ user }) => {
        if (!cancelled) setAuth({ status: "authenticated", user });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // 401 is the normal "not signed in" answer and needs no explanation.
        // Anything else (the API down, a 500) still leaves the login form as the
        // only sensible screen — but the user is told why they are looking at
        // it, instead of being left to conclude their password stopped working.
        if (cause instanceof ApiError && cause.status === 401) {
          setAuthError(null);
        } else {
          console.error("[client] /api/auth/me failed:", cause);
          setAuthError(describeError(cause, "ログイン状態を確認できませんでした"));
        }
        setAuth({ status: "anonymous" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    getHealth()
      .then((data) => {
        if (!cancelled) setHealth({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setHealth({ status: "error", message: describeError(cause, "サーバーに接続できませんでした") });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="app">
      <h1 className="app__title">習慣トラッカー</h1>

      {auth.status === "checking" && <p className="muted">読み込み中…</p>}
      {auth.status === "anonymous" && (
        <LoginPage
          notice={authError}
          onLoggedIn={(user) => {
            setAuthError(null);
            setAuth({ status: "authenticated", user });
          }}
        />
      )}
      {auth.status === "authenticated" && <Dashboard user={auth.user} onLoggedOut={goAnonymous} />}

      <section className="card" aria-labelledby="health-heading">
        <h2 className="card__title" id="health-heading">
          サーバー接続
        </h2>
        <HealthLine health={health} />
      </section>
    </main>
  );
}

function HealthLine({ health }: { health: HealthState }) {
  if (health.status === "loading") {
    return (
      <p className="health-status health-status--loading" data-testid="health-status" role="status">
        接続確認中…
      </p>
    );
  }

  if (health.status === "error") {
    return (
      <p className="health-status health-status--error" data-testid="health-status" role="status">
        API 接続: エラー（{health.message}）
      </p>
    );
  }

  return (
    <>
      <p className="health-status health-status--ok" data-testid="health-status" role="status">
        API 接続: {health.data.ok ? "ok" : "ng"}
      </p>
      <pre className="health-raw" data-testid="health-raw">
        {JSON.stringify(health.data)}
      </pre>
    </>
  );
}
