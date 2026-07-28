import { useEffect, useState } from "react";
import type { HealthResponse } from "../../shared/types.ts";
import { getHealth } from "./api.ts";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; data: HealthResponse }
  | { status: "error"; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });

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
