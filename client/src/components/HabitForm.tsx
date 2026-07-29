import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { formatValue } from "../../../shared/domain.ts";
import type { CreateHabitRequest, Habit, HabitKind, UpdateHabitRequest } from "../../../shared/types.ts";
import { describeError } from "../errors.ts";

/**
 * Creates a habit, or edits the one passed in.
 *
 * One component for both jobs on purpose: "name and target" must mean the same
 * thing when creating and when editing, and two forms would drift apart.
 *
 * The kind cannot be changed after creation (the server refuses it too): past
 * entries were recorded in the old kind's terms, and silently reinterpreting
 * them would rewrite history.
 */

type HabitFormProps = {
  /** The habit being edited, or null to create a new one. */
  habit: Habit | null;
  onCreate: (input: CreateHabitRequest) => Promise<unknown>;
  onUpdate: (id: number, patch: UpdateHabitRequest) => Promise<unknown>;
  onCancelEdit: () => void;
};

const KIND_LABELS: Record<HabitKind, string> = {
  boolean: "チェック式",
  numeric: "数値式",
};

export function HabitForm({ habit, onCreate, onUpdate, onCancelEdit }: HabitFormProps) {
  const editing = habit !== null;

  const [name, setName] = useState("");
  const [kind, setKind] = useState<HabitKind>("boolean");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Switching between "new" and "editing X" refills the fields. Numbers are
  // rendered through formatValue so a target stored as 30.0 shows up as "30".
  useEffect(() => {
    if (habit === null) {
      setName("");
      setKind("boolean");
      setTarget("");
      setUnit("");
    } else {
      setName(habit.name);
      setKind(habit.kind);
      setTarget(habit.target === null ? "" : formatValue(habit.target));
      setUnit(habit.unit ?? "");
    }
    setError(null);
  }, [habit]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;

    const trimmedName = name.trim();
    if (trimmedName === "") {
      setError("習慣名を入力してください");
      return;
    }

    // Only numeric habits carry a target, and an empty box means "no goal" —
    // `isAchieved()` then counts any value above zero (docs/design.md §2). That
    // is the only way to *remove* a goal, so the field cannot be mandatory; what
    // is still rejected here (before the round trip, and again on the server) is
    // a number that is not one: 0, negative, or not a number at all.
    let parsedTarget: number | null = null;
    if (kind === "numeric" && target.trim() !== "") {
      parsedTarget = Number(target.trim());
      if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
        setError("目標値は 0 より大きい数値で入力してください（空欄なら目標なし）");
        return;
      }
    }

    setPending(true);
    setError(null);

    try {
      if (habit === null) {
        await onCreate({
          name: trimmedName,
          kind,
          target: parsedTarget,
          unit: kind === "numeric" ? unit.trim() || null : null,
        });
        // A cleared form is the signal that the habit landed in the list.
        setName("");
        setTarget("");
        setUnit("");
        setKind("boolean");
      } else {
        await onUpdate(habit.id, {
          name: trimmedName,
          target: parsedTarget,
          unit: kind === "numeric" ? unit.trim() || null : null,
        });
      }
    } catch (cause) {
      // Beside the fields the user just filled in, whatever failed: a validation
      // 400, a 500, or the server not answering at all (AC-6.4).
      setError(describeError(cause, "保存できませんでした"));
    } finally {
      setPending(false);
    }
  }

  const headingId = "habit-form-heading";

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 className="card__title" id={headingId}>
        {editing ? "習慣を編集" : "習慣を追加"}
      </h2>

      <form className="form" onSubmit={handleSubmit}>
        <div className="form__field">
          <label htmlFor="habit-name">習慣名</label>
          <input
            id="habit-name"
            name="name"
            type="text"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        {editing ? (
          // Immutable once created, so it is shown rather than offered.
          <p className="form__static" data-testid="habit-form-kind">
            種類: {KIND_LABELS[kind]}
          </p>
        ) : (
          <fieldset className="form__fieldset">
            <legend>種類</legend>
            {(["boolean", "numeric"] as const).map((option) => (
              <label className="form__radio" key={option} htmlFor={`habit-kind-${option}`}>
                <input
                  id={`habit-kind-${option}`}
                  type="radio"
                  name="kind"
                  value={option}
                  checked={kind === option}
                  onChange={() => setKind(option)}
                />
                {KIND_LABELS[option]}
              </label>
            ))}
          </fieldset>
        )}

        {kind === "numeric" && (
          <>
            <div className="form__field">
              <label htmlFor="habit-target">目標値</label>
              <input
                id="habit-target"
                name="target"
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="空欄なら目標なし"
                aria-describedby="habit-target-hint"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
              {/* A description, not part of the field's accessible name: the
                  label stays "目標値" so it is still addressable by it. */}
              <span className="form__hint" id="habit-target-hint">
                空欄にすると目標なしになり、0 より大きい記録が達成扱いになります。
              </span>
            </div>

            <div className="form__field">
              <label htmlFor="habit-unit">単位</label>
              <input
                id="habit-unit"
                name="unit"
                type="text"
                maxLength={12}
                placeholder="分 / 回 / ページ"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
              />
            </div>
          </>
        )}

        {error !== null && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}

        <div className="form__actions">
          <button className="button" type="submit" disabled={pending}>
            {editing ? "保存" : "追加"}
          </button>
          {editing && (
            <button className="button button--quiet" type="button" onClick={onCancelEdit} disabled={pending}>
              キャンセル
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
