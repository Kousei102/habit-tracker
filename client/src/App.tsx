import { Dashboard } from "./components/Dashboard.tsx";

/**
 * The whole app.
 *
 * There is nothing to check before rendering: the data is in `localStorage`, the
 * store reads it synchronously, and there is no session to confirm first. Opening
 * `/` therefore lands straight on the dashboard (AC-7.4) — no login screen, and
 * no "読み込み中…" flash while a request decides which screen to show.
 */
export function App() {
  return (
    <main className="app">
      <h1 className="app__title">習慣トラッカー</h1>
      <Dashboard />
    </main>
  );
}
