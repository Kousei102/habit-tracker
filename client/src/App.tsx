import { useCallback, useEffect, useState } from "react";
import type { HealthResponse, SessionUser } from "../../shared/types.ts";
import { ApiError, getHealth, getMe, setUnauthorizedHandler } from "./api.ts";
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

  const goAnonymous = useCallback(() => setAuth({ status: "anonymous" }), []);

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
        // 401 is the normal "not signed in" answer. Anything else (server down)
        // still leaves the login form as the only sensible screen; the health
        // readout below is what tells the user the API is unreachable.
        if (!(cause instanceof ApiError) || cause.status !== 401) {
          console.error("[client] /api/auth/me failed:", cause);
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
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setHealth({ status: "error", message });
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
        <LoginPage onLoggedIn={(user) => setAuth({ status: "authenticated", user })} />
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
