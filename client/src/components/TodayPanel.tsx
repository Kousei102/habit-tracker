import { useEffect, useRef, useState } from "react";
import { formatValue, isAchieved } from "../../../shared/domain.ts";
import type { Habit } from "../../../shared/types.ts";
import { ApiError } from "../api.ts";
import type { HabitsStatus } from "../hooks/useHabits.ts";

/**
 * Today's habits: one row per habit, recording the day's value in place.
 *
 * Whether a row reads as done is `isAchieved()` from shared/domain.ts and
 * nothing else. A `value >= target` written here would be a second definition of
 * "done" that the streak maths does not share.
 */

type TodayPanelProps = {
  /** `YYYY-MM-DD` — the day these rows record, decided by the browser. */
  today: string;
  habits: Habit[];
  values: Record<number, number>;
  status: HabitsStatus;
  error: string | null;
  onSetValue: (habitId: number, value: number) => Promise<void>;
  onEdit: (habit: Habit) => void;
  onDelete: (habit: Habit) => Promise<void>;
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

type HabitRowProps = {
  habit: Habit;
  /** Today's stored value. No record for today reads as 0. */
  value: number;
  onSetValue: (habitId: number, value: number) => Promise<void>;
  onEdit: (habit: Habit) => void;
  onDelete: (habit: Habit) => Promise<void>;
};

function HabitRow({ habit, value, onSetValue, onEdit, onDelete }: HabitRowProps) {
  // While a write is in flight the row shows what is being written, so the tick
  // follows the click immediately; on failure it snaps back to the stored value.
  const [pendingValue, setPendingValue] = useState<number | null>(null);
  const [draft, setDraft] = useState(() => formatValue(value));
  const [saving, setSaving] = useState(false);
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

  async function save(next: number): Promise<void> {
    lastSent.current = next;
    setPendingValue(next);
    setSaving(true);
    setRowError(null);
    try {
      await onSetValue(habit.id, next);
    } catch (cause) {
      lastSent.current = null;
      setDraft(formatValue(value));
      setRowError(cause instanceof ApiError ? cause.message : "記録を保存できませんでした");
    } finally {
      setPendingValue(null);
      setSaving(false);
    }
  }

  function handleNumberChange(text: string): void {
    setDraft(text);
    if (text.trim() === "") return; // a cleared box is mid-edit, not a value of 0
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    void save(parsed);
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
              onChange={(event) => void save(event.target.checked ? 1 : 0)}
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
        {saving && (
          <span className="habit__saving" data-testid="habit-saving">
            保存中…
          </span>
        )}
        <button
          className="button button--quiet button--small"
          type="button"
          aria-label={`${habit.name} を編集`}
          onClick={() => onEdit(habit)}
        >
          編集
        </button>
        {/* No confirm() dialog: a habit is recoverable (the row is only archived),
            and a modal the user cannot see coming is worse than an undo they can. */}
        <button
          className="button button--quiet button--small"
          type="button"
          aria-label={`${habit.name} を削除`}
          onClick={() => void onDelete(habit)}
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
