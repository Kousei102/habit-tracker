import type { ReactNode } from "react";
import type { Habit, HabitStats } from "../../../shared/types.ts";
import type { StatsStatus } from "../hooks/useStats.ts";

/**
 * Streaks and the 30 day achievement rate, one block per habit.
 *
 * These are headline numbers, not a plot: three stat tiles per habit (label +
 * value) rather than a chart of three bars. The achievement rate additionally
 * gets a meter — a single ratio against a fixed limit — but the meter is
 * decoration: the percentage and the raw "5 / 30 日" are always spelled out, so
 * nothing here is carried by colour or length alone.
 *
 * No maths lives in this file. Every number arrives from `GET /api/stats`, which
 * computes it with the shared `isAchieved()` rule; recomputing anything here
 * would be the second definition of "done" the design forbids.
 */

type StatsPanelProps = {
  /** `YYYY-MM-DD` the numbers are computed as of — the browser's day. */
  today: string;
  /** The habits to show, in list order. */
  habits: Habit[];
  /** Stats keyed by habit id, as loaded by `useStats`. */
  byHabit: Record<number, HabitStats>;
  status: StatsStatus;
  error: string | null;
};

/** `5 / 30` → `17`. Whole percent: the exact fraction is shown next to it. */
function toPercent(stats: HabitStats): number {
  if (stats.window_days <= 0) return 0;
  return Math.round((stats.achieved_days / stats.window_days) * 100);
}

export function StatsPanel({ today, habits, byHabit, status, error }: StatsPanelProps) {
  return (
    <section className="card" aria-labelledby="stats-heading">
      <div className="stats__header">
        <h2 className="card__title" id="stats-heading">
          統計
        </h2>
        <p className="stats__asof" data-testid="stats-today">
          {today} 時点
        </p>
      </div>

      {status === "loading" && <p className="muted">読み込み中…</p>}

      {/* Failing out loud rather than showing zeroes that look like real data. */}
      {status === "error" && (
        <p className="form__error" role="alert">
          統計を読み込めませんでした（{error}）
        </p>
      )}

      {status === "ready" && habits.length === 0 && (
        <p className="muted">習慣を登録すると、ここにストリークと達成率が表示されます。</p>
      )}

      {status === "ready" && habits.length > 0 && (
        <ul className="stats" aria-label="習慣の統計">
          {habits.map((habit) => (
            <HabitStatsItem key={habit.id} habit={habit} stats={byHabit[habit.id]} />
          ))}
        </ul>
      )}
    </section>
  );
}

type HabitStatsItemProps = {
  habit: Habit;
  /** Absent only in the moment between creating a habit and the reload landing. */
  stats: HabitStats | undefined;
};

function HabitStatsItem({ habit, stats }: HabitStatsItemProps) {
  const percent = stats === undefined ? 0 : toPercent(stats);

  return (
    <li className="stats__item" data-testid="habit-stats" data-habit-id={habit.id}>
      <h3 className="stats__name">{habit.name}</h3>

      <div className="stats__tiles">
        <Tile
          testId="current-streak"
          label="現在ストリーク"
          value={stats === undefined ? "—" : `${stats.current_streak} 日`}
        />
        <Tile
          testId="longest-streak"
          label="最長ストリーク"
          value={stats === undefined ? "—" : `${stats.longest_streak} 日`}
        />
        <Tile
          testId="achievement-rate"
          label="直近 30 日の達成率"
          value={stats === undefined ? "—" : `${percent}%`}
          detail={stats === undefined ? undefined : `${stats.achieved_days} / ${stats.window_days} 日`}
        >
          {/* aria-hidden: the tile already says "17%（5 / 30 日）" in words, and a
              screen reader gains nothing from hearing the bar a second time. */}
          <div className="meter" aria-hidden="true">
            <div className="meter__fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
          </div>
        </Tile>
      </div>
    </li>
  );
}

type TileProps = {
  testId: string;
  label: string;
  value: string;
  detail?: string | undefined;
  children?: ReactNode;
};

/**
 * One label/value pair. A `div`, not a `p`: the rate tile puts a meter inside,
 * and a block element inside a paragraph is invalid HTML that the parser would
 * silently rearrange.
 *
 * The `{" "}` between the spans is load-bearing: without it the tile's text
 * content reads "現在ストリーク5 日" with the words run together, which is wrong
 * for anything reading the text rather than the layout.
 */
function Tile({ testId, label, value, detail, children }: TileProps) {
  return (
    <div className="stat" data-testid={testId}>
      <span className="stat__label">{label}</span>{" "}
      <span className="stat__value">{value}</span>
      {/* No space before the detail: the full-width bracket is the separator, and
          an extra one would read as "13% （4 / 30 日）". */}
      {detail !== undefined && <span className="stat__detail">（{detail}）</span>}
      {children}
    </div>
  );
}
