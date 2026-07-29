import { useMemo, useState } from "react";
import {
  HEATMAP_COLUMNS,
  HEATMAP_ROWS,
  buildHeatmapGrid,
  habitCellLabel,
  habitLevel,
  indexEntries,
  monthMarks,
  overallCellLabel,
  overallLevel,
  weekdayName,
  weekdayOf,
} from "../../../shared/heatmap.ts";
import type { HeatLevel } from "../../../shared/heatmap.ts";
import type { Entry, Habit } from "../../../shared/types.ts";
import type { EntryHistoryStatus } from "../hooks/useEntryHistory.ts";

/**
 * The year heatmap: 7 weekday rows × 53 week columns, drawn as plain SVG.
 *
 * No chart library (AC-5.7) — the grid is 371 rects, and a dependency would buy
 * nothing but its own bundle. Every number it shows comes from
 * `shared/heatmap.ts`, whose top shade is `isAchieved()`; this file only turns a
 * level into a colour and a label into an accessible name.
 *
 * Colour is a **sequential** ramp: one hue (blue), four steps light→dark, plus a
 * neutral "no record" step. Dark mode is a second set of steps chosen against
 * the dark surface, not an inversion (see styles.css). Nothing is carried by
 * colour alone: every cell announces its date and its value, and the legend
 * spells the ramp out in words.
 */

const CELL = 11;
const GAP = 2; // the surface gap that separates touching marks — never a stroke
const STEP = CELL + GAP;
/** Room on the left for the weekday labels. */
const GUTTER_X = 26;
/** Room on top for the month labels. */
const GUTTER_Y = 14;

/** Room on the right for the last month label, which an SVG would otherwise clip. */
const PAD_RIGHT = 16;

const PLOT_WIDTH = GUTTER_X + HEATMAP_COLUMNS * STEP - GAP + PAD_RIGHT;
const PLOT_HEIGHT = GUTTER_Y + HEATMAP_ROWS * STEP - GAP;

/** Weekday labels are drawn on every other row, or they collide at 11px cells. */
const LABELLED_ROWS = [1, 3, 5];

const SHORT_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

type HeatmapPanelProps = {
  /** `YYYY-MM-DD` — the browser's day, and the right-hand edge of the grid. */
  today: string;
  /** Active habits, in list order. The denominator of the overall view. */
  habits: Habit[];
  /** Deleted habits. Not part of the overall view — only of their own map. */
  archivedHabits: Habit[];
  /** A year of records, as loaded by `useEntryHistory`. */
  entries: Entry[];
  status: EntryHistoryStatus;
  error: string | null;
};

type Cell = {
  date: string;
  level: HeatLevel;
  label: string;
};

/** One entry in the picker: the overall view, or one habit's own map. */
type Choice = {
  /** The `<option value>`; "all" for the overall view, otherwise the habit id. */
  key: string;
  label: string;
  /** null for the overall view. */
  habit: Habit | null;
};

const OVERALL_KEY = "all";
const OVERALL_LABEL = "全体";

export function HeatmapPanel({ today, habits, archivedHabits, entries, status, error }: HeatmapPanelProps) {
  const [selectedKey, setSelectedKey] = useState<string>(OVERALL_KEY);

  const grid = useMemo(() => buildHeatmapGrid(today), [today]);
  const index = useMemo(() => indexEntries(entries), [entries]);

  /**
   * What can be shown.
   *
   * A deleted habit whose records are inside the window is offered too. Deletion
   * is logical precisely so the year does not grow a hole (docs/design.md §4),
   * and until now the panel disagreed: with every habit deleted it drew nothing
   * at all, however much history was sitting in the database. Deleted habits
   * without a record in the window are left out — an empty grid under a name is
   * not worth a line in the menu.
   *
   * The overall view is offered only while there is at least one active habit,
   * because its shade is "achieved out of the habits you keep": with none left,
   * every day would honestly read 記録なし, which is a blank grid pretending to
   * be an answer.
   */
  const choices = useMemo<Choice[]>(() => {
    const list: Choice[] = [];
    if (habits.length > 0) list.push({ key: OVERALL_KEY, label: OVERALL_LABEL, habit: null });

    for (const habit of habits) list.push({ key: String(habit.id), label: habit.name, habit });

    const recorded = new Set(entries.map((entry) => entry.habit_id));
    for (const habit of archivedHabits) {
      if (!recorded.has(habit.id)) continue;
      // Named as deleted, so the picker never claims a habit still exists.
      list.push({ key: String(habit.id), label: `${habit.name}（削除済み）`, habit });
    }

    return list;
  }, [habits, archivedHabits, entries]);

  // The selection can stop existing under the user — deleting the habit whose
  // map is on screen, or losing the overall view with the last active habit — so
  // it is resolved against the current choices rather than trusted.
  const selected = choices.find((choice) => choice.key === selectedKey) ?? choices[0];
  const shown = selected?.habit ?? null;

  const cells = useMemo<Cell[][]>(() => {
    return grid.map((column) =>
      column.map((date) => {
        const values = index.get(date);

        if (shown === null) {
          return {
            date,
            level: overallLevel(habits, values),
            label: overallCellLabel(date, habits, values),
          };
        }

        const value = values?.get(shown.id);
        return {
          date,
          level: habitLevel(shown, value),
          label: habitCellLabel(shown, date, value),
        };
      }),
    );
  }, [grid, index, habits, shown]);

  const firstDay = grid[0]?.[0] ?? today;
  const subject = selected?.label ?? OVERALL_LABEL;

  return (
    <section className="card" aria-labelledby="heatmap-heading">
      <div className="heatmap__header">
        <h2 className="card__title" id="heatmap-heading">
          年間ヒートマップ
        </h2>

        {choices.length > 0 && (
          <div className="heatmap__picker">
            <label htmlFor="heatmap-target">表示する習慣</label>
            <select
              id="heatmap-target"
              data-testid="heatmap-target"
              // The control is narrower than a long habit name (styles.css), so
              // the full text has to stay available somewhere a pointer can
              // reach it. The accessible name is unaffected: that comes from the
              // <label>, and a title never overrides one.
              title={selected?.label ?? OVERALL_LABEL}
              value={selected?.key ?? OVERALL_KEY}
              onChange={(event) => setSelectedKey(event.target.value)}
            >
              {choices.map((choice) => (
                <option key={choice.key} value={choice.key} title={choice.label}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <p className="heatmap__range" data-testid="heatmap-range">
        {firstDay} 〜 {today}
      </p>

      {status === "loading" && <p className="muted">読み込み中…</p>}

      {/* Failing out loud: an all-empty grid would read as "you did nothing". */}
      {status === "error" && (
        <p className="form__error" role="alert">
          記録を読み込めませんでした（{error}）
        </p>
      )}

      {/* Worded so it shares no leading phrase with the other panels' empty
          states: they are addressed by their text, and two paragraphs starting
          the same way are one ambiguous locator. */}
      {status === "ready" && choices.length === 0 && <p className="muted">まだ表示できる記録がありません。</p>}

      {status === "ready" && selected !== undefined && (
        <>
          <HeatmapGrid subject={subject} firstDay={firstDay} today={today} grid={grid} cells={cells} />
          <Legend subject={subject} />
        </>
      )}
    </section>
  );
}

type HeatmapGridProps = {
  subject: string;
  firstDay: string;
  today: string;
  grid: string[][];
  cells: Cell[][];
};

/**
 * The SVG itself.
 *
 * Rows are weekdays and columns are weeks, so the grid is transposed relative to
 * `cells` (which is column-major) — the rows have to be emitted top to bottom
 * for `role="row"` to describe what a reader actually meets.
 */
function HeatmapGrid({ subject, firstDay, today, grid, cells }: HeatmapGridProps) {
  const [hovered, setHovered] = useState<{ x: number; y: number; text: string } | null>(null);

  // One label per month, at the column the month starts in, thinned out so two
  // of them cannot overlap at 13px per column. The rule for *which* one to drop
  // lives in shared/heatmap.ts, where node:test can check that no month is ever
  // left unlabelled.
  const months = useMemo(() => monthMarks(grid), [grid]);

  /**
   * The 371 rects, built once per data change.
   *
   * Memoised because the tooltip lives in this component's state: without it,
   * every mouse move would reconcile the whole grid. Holding on to the same
   * element references lets React skip the subtree entirely.
   */
  const rows = useMemo(
    () =>
      Array.from({ length: HEATMAP_ROWS }, (_, row) => (
        <g key={row} role="row" aria-label={weekdayName(grid[0]?.[row] ?? today)}>
          {cells.map((column, columnIndex) => {
            const cell = column[row];
            if (cell === undefined) return null;

            return (
              <rect
                key={cell.date}
                className="heatmap__cell"
                role="gridcell"
                aria-label={cell.label}
                data-date={cell.date}
                data-level={cell.level}
                x={GUTTER_X + columnIndex * STEP}
                y={GUTTER_Y + row * STEP}
                width={CELL}
                height={CELL}
                rx={2}
              />
            );
          })}
        </g>
      )),
    [cells, grid, today],
  );

  /**
   * The tooltip says exactly what the cell announces.
   *
   * Read from `aria-label` rather than from a `data-label` copy of it: two
   * attributes holding the same sentence is two places to fix when the wording
   * changes, and the one that gets forgotten is the one nobody can see.
   */
  function showTip(event: { target: unknown; clientX: number; clientY: number }): void {
    const element = event.target as Element | null;
    // Only a cell has something to say. The `<svg>` and the row groups carry
    // accessible names of their own, and the pointer passes over both.
    const isCell = element?.getAttribute?.("role") === "gridcell";
    const text = isCell ? (element?.getAttribute("aria-label") ?? null) : null;
    if (text === null) {
      setHovered(null);
      return;
    }
    setHovered({ x: event.clientX, y: event.clientY, text });
  }

  return (
    <div className="heatmap__scroll">
      <svg
        className="heatmap__svg"
        role="grid"
        aria-label={`${subject} の年間ヒートマップ（${firstDay} 〜 ${today}）`}
        data-testid="heatmap"
        data-subject={subject}
        width={PLOT_WIDTH}
        height={PLOT_HEIGHT}
        viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
        onMouseMove={showTip}
        onMouseLeave={() => setHovered(null)}
      >
        {/* Chrome, not data: the cells carry the dates a reader needs. */}
        <g aria-hidden="true" className="heatmap__axis">
          {months.map(({ column, month }) => (
            <text key={`${column}-${month}`} x={GUTTER_X + column * STEP} y={GUTTER_Y - 4}>
              {month}月
            </text>
          ))}
          {LABELLED_ROWS.map((row) => (
            <text key={row} x={0} y={GUTTER_Y + row * STEP + CELL - 1}>
              {SHORT_WEEKDAYS[weekdayOf(grid[0]?.[row] ?? today)]}
            </text>
          ))}
        </g>

        {rows}
      </svg>

      {/* Fixed, so an overflowing tooltip can never widen the page (AC-5.5), and
          aria-hidden because the cell it describes already announces the same
          text. */}
      {hovered !== null && (
        <div
          className="heatmap__tip"
          aria-hidden="true"
          style={{
            left: Math.min(Math.max(hovered.x, 72), window.innerWidth - 72),
            top: hovered.y - 12,
          }}
        >
          {hovered.text}
        </div>
      )}
    </div>
  );
}

const LEGEND_STEPS: HeatLevel[] = [1, 2, 3, 4];

/**
 * The scale, in words as well as colour.
 *
 * A sequential ramp needs its ends named, and "no record" is a separate,
 * qualitative step rather than the bottom of the ramp — so it is shown apart
 * from it, which is also what AC-5.6 asks a reader to be able to see.
 */
function Legend({ subject }: { subject: string }) {
  return (
    <div className="heatmap__legend">
      <span className="heatmap__legend-item">
        <span className="heatmap__swatch" data-level={0} aria-hidden="true" />
        記録なし
      </span>
      <span className="heatmap__legend-item">
        少ない
        {LEGEND_STEPS.map((level) => (
          <span key={level} className="heatmap__swatch" data-level={level} aria-hidden="true" />
        ))}
        多い（達成）
      </span>
      <span className="heatmap__legend-note">
        {subject === "全体" ? "その日に達成した習慣の割合" : "目標に対する達成の割合"}
      </span>
    </div>
  );
}
