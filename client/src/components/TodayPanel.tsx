import { useEffect, useRef, useState } from "react";
import { formatValue, isAchieved } from "../../../shared/domain.ts";
import type { Habit } from "../../../shared/types.ts";
import { describeError } from "../errors.ts";
import type { HabitsStatus } from "../hooks/useHabits.ts";

/**
 * Today's habits: one row per habit, recording the day's value in place.
 *
 * Whether a row reads as done is `isAchieved()` from shared/domain.ts and
 * nothing else. A `value >= target` written here would be a second definition of
 * "done" that the streak maths does not share.
 *
 * Recording is synchronous (the store is `localStorage`), so there is no
 * "saving…" state to show: by the time the click handler returns, the value is
 * stored or the row is showing why it is not.
 */

type TodayPanelProps = {
  /** `YYYY-MM-DD` — the day these rows record, decided by the browser. */
  today: string;
  habits: Habit[];
  values: Record<number, number>;
  status: HabitsStatus;
  error: string | null;
  /** Throws when the record cannot be stored; the row shows the message. */
  onSetValue: (habitId: number, value: number) => void;
  onEdit: (habit: Habit) => void;
  onDelete: (habit: Habit) => void;
};

export function TodayPanel({
  today,
  habits,
  values,
  status,
  error,
  onSetValue,
  onEdit,
  onDelete,
}: TodayPanelProps) {
  return (
    <section className="card" aria-labelledby="today-heading">
      <div className="today__header">
        <h2 className="card__title" id="today-heading">
          今日の習慣
        </h2>
        <p className="today__date" data-testid="today-date">
          {today}
        </p>
      </div>

      {status === "loading" && <p className="muted">読み込み中…</p>}

      {/* Failing out loud rather than showing a permanent spinner (AC-6.4). */}
      {status === "error" && (
        <p className="form__error" role="alert">
          習慣を読み込めませんでした（{error}）
        </p>
      )}

      {status === "ready" && habits.length === 0 && <p className="muted">習慣がまだ登録されていません。</p>}

      {status === "ready" && habits.length > 0 && (
        <ul className="habits" aria-label="習慣一覧">
          {habits.map((habit) => (
            <HabitRow
              key={habit.id}
              habit={habit}
              value={values[habit.id] ?? 0}
              onSetValue={onSetValue}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * How long a numeric field waits after the last keystroke before saving.
 *
 * Typing "120" would otherwise be three writes and three full recomputations of
 * the streaks — and each of those reads every entry the user has, which at five
 * years of history is not free. Now it is one of each. Short enough that the save
 * still feels immediate; the pending value is on screen the whole time, and blur,
 * or the page going away, flushes it early so nothing typed can be lost.
 */
const SAVE_DEBOUNCE_MS = 300;

type HabitRowProps = {
  habit: Habit;
  /** Today's stored value. No record for today reads as 0. */
  value: number;
  onSetValue: (habitId: number, value: number) => void;
  onEdit: (habit: Habit) => void;
  onDelete: (habit: Habit) => void;
};

function HabitRow({ habit, value, onSetValue, onEdit, onDelete }: HabitRowProps) {
  // While a value is queued behind the debounce the row shows it, so 達成 /
  // 未達成 follows the keystroke; on failure it snaps back to the stored value.
  const [pendingValue, setPendingValue] = useState<number | null>(null);
  const [draft, setDraft] = useState(() => formatValue(value));
  const [rowError, setRowError] = useState<string | null>(null);
  /** The last value this row sent, so an echo of our own write leaves the text box alone. */
  const lastSent = useRef<number | null>(null);

  const shownValue = pendingValue ?? value;
  const achieved = isAchieved(habit, shownValue);

  // Re-sync the text box when the value changed elsewhere (a reload), but never
  // while the user is mid-edit of a value we ourselves just saved — rewriting
  // "2." to "2" under the cursor makes decimals impossible to type.
  useEffect(() => {
    if (lastSent.current !== null && lastSent.current === value) return;
    setDraft(formatValue(value));
  }, [value]);

  function save(next: number): void {
    lastSent.current = next;
    setPendingValue(next);
    setRowError(null);
    try {
      onSetValue(habit.id, next);
    } catch (cause) {
      lastSent.current = null;
      setDraft(formatValue(value));
      // Whatever went wrong — storage full, storage blocked, an unreadable
      // document — the row says so rather than quietly snapping back to the old
      // value (AC-7.12). This is the path a debounced save takes too: `flush`
      // ends up here, so a write the user never explicitly triggered still
      // reports.
      setRowError(describeError(cause, "記録を保存できませんでした"));
    } finally {
      // Unless newer typing is already waiting to be written: dropping back to
      // the stored value between two saves would make the row flicker through a
      // state the user has already moved past.
      if (queued.current === null) setPendingValue(null);
    }
  }

  /** The value waiting for the debounce to expire, and the timer holding it. */
  const queued = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Writes whatever is queued, now. Safe to call when nothing is queued. */
  function flush(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    const next = queued.current;
    queued.current = null;
    if (next === null) return;

    save(next);
  }

  // `flush` closes over this render's `save`; the listeners below are installed
  // once, so they reach it through a ref rather than a stale copy.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    // The worst case is typing and then leaving straight away: the debounce has
    // not expired, and the row is about to be destroyed. The write itself is a
    // synchronous `localStorage.setItem`, so once `flush` runs the value is on
    // disk before the page can go — which is what keeps AC-3.4 ("the value
    // survives a reload") true. The job here is to get `flush` called in time.
    //
    // Two listeners, because neither fires everywhere:
    //  - `pagehide` covers reloads and navigations, including into the bfcache;
    //  - `visibilitychange` → hidden is the *only* one a mobile browser
    //    guarantees when the app is switched away and later killed in the
    //    background. On that path `pagehide` may never arrive at all.
    // Both end up in `flush`, which is idempotent: with nothing queued it does
    // nothing, so a browser that fires both writes once.
    const onHide = () => flushRef.current();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };

    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  function handleNumberChange(text: string): void {
    setDraft(text);
    if (text.trim() === "") return; // a cleared box is mid-edit, not a value of 0
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 0) return;

    // Shown immediately, written once the typing stops: 達成 / 未達成 and the
    // "3 / 5 km" line follow the keystroke, the request does not.
    queued.current = parsed;
    setPendingValue(parsed);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      flushRef.current();
    }, SAVE_DEBOUNCE_MS);
  }

  const controlId = `habit-${habit.id}-value`;
  const unitSuffix = habit.unit === null || habit.unit === "" ? "" : ` ${habit.unit}`;

  return (
    <li className="habit" data-testid="habit-item" data-habit-id={habit.id} data-achieved={achieved}>
      <div className="habit__control">
        {habit.kind === "boolean" ? (
          <>
            <input
              id={controlId}
              className="habit__check"
              type="checkbox"
              checked={achieved}
              onChange={(event) => save(event.target.checked ? 1 : 0)}
            />
            {/* The label is the habit's name, so the checkbox's accessible name is the habit. */}
            <label className="habit__name" htmlFor={controlId}>
              {habit.name}
            </label>
          </>
        ) : (
          <>
            <label className="habit__name" htmlFor={controlId}>
              {habit.name}
            </label>
            <input
              id={controlId}
              className="habit__number"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={draft}
              onChange={(event) => handleNumberChange(event.target.value)}
              onBlur={() => {
                // Leaving the field ends the edit: no reason to keep waiting.
                flush();
                if (draft.trim() === "") setDraft(formatValue(value));
              }}
            />
            {unitSuffix !== "" && <span className="habit__unit">{habit.unit}</span>}
          </>
        )}
      </div>

      {/* AC-3.2: the day's result and the goal, readable side by side ("0 / 30 分"). */}
      {habit.kind === "numeric" && (
        <p className="habit__progress" data-testid="habit-progress">
          {habit.target === null
            ? `${formatValue(shownValue)}${unitSuffix}`
            : `${formatValue(shownValue)} / ${formatValue(habit.target)}${unitSuffix}`}
        </p>
      )}

      <span className="habit__badge" data-testid="habit-state" data-achieved={achieved}>
        {achieved ? "達成" : "未達成"}
      </span>

      <div className="habit__actions">
        <button
          className="button button--quiet button--small"
          type="button"
          aria-label={`${habit.name} を編集`}
          onClick={() => onEdit(habit)}
        >
          編集
        </button>
        {/* No confirm() dialog: the delete is logical, and the dashboard offers
            「削除を取り消す」 straight afterwards. An undo the user can see beats a
            modal they did not ask for. */}
        <button
          className="button button--quiet button--small"
          type="button"
          aria-label={`${habit.name} を削除`}
          onClick={() => onDelete(habit)}
        >
          削除
        </button>
      </div>

      {rowError !== null && (
        <p className="form__error habit__error" role="alert">
          {rowError}
        </p>
      )}
    </li>
  );
}
