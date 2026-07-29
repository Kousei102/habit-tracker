import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays } from "./domain.ts";
import type { DatedValue, StatsHabit } from "./stats.ts";
import { RATE_WINDOW_DAYS, computeHabitStats, computeStats } from "./stats.ts";

/**
 * Streak maths is the most bug-prone corner of this app, so the acceptance
 * criteria for it are unit tests rather than screenshots (AC-4.1 … AC-4.6).
 *
 * Every date below is a literal. Nothing here reads a clock — that is the point
 * of the design: "today" is an argument, so a test can ask about any day.
 */

/** The day the E2E clock is pinned to, reused here so the two agree. */
const TODAY = "2026-03-15";

/** `YYYY-MM-DD` for n days before TODAY. `ago(0)` is TODAY. */
function ago(n: number): string {
  return addDays(TODAY, -n);
}

const CHECK: StatsHabit = { id: 1, kind: "boolean", target: null };
/** 30 分読む、のような目標つきの数値習慣。 */
const NUMERIC: StatsHabit = { id: 2, kind: "numeric", target: 30 };

/** Records for `boolean` habits: the listed days are done, nothing else exists. */
function done(...daysAgo: number[]): DatedValue[] {
  return daysAgo.map((n) => ({ date: ago(n), value: 1 }));
}

describe("computeHabitStats — current streak", () => {
  // AC-4.3
  it("counts today when today is achieved (3 days including today → 3)", () => {
    const stats = computeHabitStats(CHECK, done(0, 1, 2), TODAY);

    assert.equal(stats.current_streak, 3);
    assert.equal(stats.longest_streak, 3);
  });

  // AC-4.2 — the rule this whole phase exists for.
  it("survives an unfinished today: 3 days up to yesterday → 3", () => {
    // No record at all for today: the day is simply not over.
    const stats = computeHabitStats(CHECK, done(1, 2, 3), TODAY);

    assert.equal(stats.current_streak, 3);
  });

  it("survives a today that is explicitly recorded as not done", () => {
    // An existing row with value 0 ("not done yet") must read the same as no row.
    const records = [{ date: TODAY, value: 0 }, ...done(1, 2, 3)];

    assert.equal(computeHabitStats(CHECK, records, TODAY).current_streak, 3);
  });

  it("is 0 when neither today nor yesterday is achieved", () => {
    // Yesterday missed: the streak really is broken, today's grace does not
    // reach back two days.
    const stats = computeHabitStats(CHECK, done(2, 3, 4), TODAY);

    assert.equal(stats.current_streak, 0);
    assert.equal(stats.longest_streak, 3);
  });

  it("counts today alone as 1", () => {
    assert.equal(computeHabitStats(CHECK, done(0), TODAY).current_streak, 1);
  });

  it("counts yesterday alone as 1", () => {
    assert.equal(computeHabitStats(CHECK, done(1), TODAY).current_streak, 1);
  });

  it("crosses a month boundary", () => {
    // 2026-03-01 back into February — the reason day maths never uses `n - 1`
    // on the day number.
    const today = "2026-03-02";
    const records = [
      { date: "2026-03-02", value: 1 },
      { date: "2026-03-01", value: 1 },
      { date: "2026-02-28", value: 1 },
      { date: "2026-02-27", value: 1 },
    ];

    assert.equal(computeHabitStats(CHECK, records, today).current_streak, 4);
  });

  it("ignores records dated after today", () => {
    // A day that has not happened cannot extend a streak, and must not bridge a
    // gap either: tomorrow is achieved, today and yesterday are not.
    const records = [{ date: addDays(TODAY, 1), value: 1 }, ...done(2, 3)];
    const stats = computeHabitStats(CHECK, records, TODAY);

    assert.equal(stats.current_streak, 0);
    assert.equal(stats.longest_streak, 2);
  });
});

describe("computeHabitStats — longest streak", () => {
  // AC-4.5
  it("stops the current streak at a gap but keeps the past best", () => {
    //  ago: 9 8 7 6 5 | 4 (missed) | 3 2 (missed today's neighbours below)
    const records = done(0, 1, 5, 6, 7, 8, 9);
    const stats = computeHabitStats(CHECK, records, TODAY);

    assert.equal(stats.current_streak, 2, "today and yesterday only");
    assert.equal(stats.longest_streak, 5, "the 5-day run that ended 5 days ago");
  });

  it("treats an explicit 0 in the middle as a break", () => {
    const records = [...done(0, 1, 2), { date: ago(3), value: 0 }, ...done(4, 5, 6, 7)];
    const stats = computeHabitStats(CHECK, records, TODAY);

    assert.equal(stats.current_streak, 3);
    assert.equal(stats.longest_streak, 4);
  });

  it("is never shorter than the current streak", () => {
    const stats = computeHabitStats(CHECK, done(0, 1, 2, 3), TODAY);

    assert.ok(
      stats.longest_streak >= stats.current_streak,
      `longest ${stats.longest_streak} < current ${stats.current_streak}`,
    );
  });

  it("does not care about the order records arrive in", () => {
    const shuffled = [...done(2, 0, 6, 1, 5)];
    const stats = computeHabitStats(CHECK, shuffled, TODAY);

    assert.equal(stats.current_streak, 3);
    assert.equal(stats.longest_streak, 3);
  });
});

// AC-4.4
describe("computeHabitStats — a habit with no records", () => {
  it("returns zeroes instead of throwing", () => {
    const stats = computeHabitStats(CHECK, [], TODAY);

    assert.equal(stats.current_streak, 0);
    assert.equal(stats.longest_streak, 0);
    assert.equal(stats.achieved_days, 0);
    assert.equal(stats.achievement_rate, 0);
    assert.equal(stats.window_days, RATE_WINDOW_DAYS);
  });

  it("returns zeroes when every record is a 0", () => {
    const records = [0, 1, 2, 3].map((n) => ({ date: ago(n), value: 0 }));
    const stats = computeHabitStats(CHECK, records, TODAY);

    assert.equal(stats.current_streak, 0);
    assert.equal(stats.longest_streak, 0);
    assert.equal(stats.achievement_rate, 0);
  });
});

// AC-4.6 — the achievement rule is shared/domain.ts's isAchieved(), so a numeric
// habit below its target is simply not an achieved day.
describe("computeHabitStats — numeric habits", () => {
  it("does not count a day below the target", () => {
    const records = [
      { date: ago(0), value: 30 },
      { date: ago(1), value: 29.9 }, // just short — still a miss
      { date: ago(2), value: 45 },
      { date: ago(3), value: 30 },
    ];
    const stats = computeHabitStats(NUMERIC, records, TODAY);

    assert.equal(stats.current_streak, 1, "yesterday fell short, so the run is today only");
    assert.equal(stats.longest_streak, 2, "45 and 30 on consecutive days");
    assert.equal(stats.achieved_days, 3);
  });

  it("counts a day that exactly meets the target", () => {
    const records = [0, 1, 2].map((n) => ({ date: ago(n), value: 30 }));

    assert.equal(computeHabitStats(NUMERIC, records, TODAY).current_streak, 3);
  });

  it("counts any positive value when no target is set", () => {
    const noTarget: StatsHabit = { id: 3, kind: "numeric", target: null };
    const records = [
      { date: ago(0), value: 0.5 },
      { date: ago(1), value: 0 },
    ];
    const stats = computeHabitStats(noTarget, records, TODAY);

    assert.equal(stats.current_streak, 1);
    assert.equal(stats.longest_streak, 1);
  });

  it("never counts a NaN value as an achievement", () => {
    const records = [{ date: ago(0), value: Number.NaN }];

    assert.equal(computeHabitStats(NUMERIC, records, TODAY).current_streak, 0);
  });
});

describe("computeHabitStats — 30 day achievement rate", () => {
  it("divides by the fixed 30 day window", () => {
    const stats = computeHabitStats(CHECK, done(0, 1, 2, 3, 4), TODAY);

    assert.equal(stats.achieved_days, 5);
    assert.equal(stats.window_days, 30);
    assert.equal(stats.achievement_rate, 5 / 30);
  });

  it("includes the 30th day back and excludes the 31st", () => {
    const inside = computeHabitStats(CHECK, done(RATE_WINDOW_DAYS - 1), TODAY);
    const outside = computeHabitStats(CHECK, done(RATE_WINDOW_DAYS), TODAY);

    assert.equal(inside.achieved_days, 1, "29 days ago is the oldest day in the window");
    assert.equal(outside.achieved_days, 0, "30 days ago has fallen out of the window");
    // …but the older day still belongs to the habit's history.
    assert.equal(outside.longest_streak, 1);
  });

  it("reaches 1 when all 30 days are achieved", () => {
    const everyDay = Array.from({ length: RATE_WINDOW_DAYS }, (_, n) => n);
    const stats = computeHabitStats(CHECK, done(...everyDay), TODAY);

    assert.equal(stats.achieved_days, 30);
    assert.equal(stats.achievement_rate, 1);
    assert.equal(stats.current_streak, 30);
  });

  it("counts a numeric day only when it met the target", () => {
    const records = [
      { date: ago(0), value: 30 },
      { date: ago(1), value: 10 },
      { date: ago(2), value: 10 },
    ];

    assert.equal(computeHabitStats(NUMERIC, records, TODAY).achieved_days, 1);
  });
});

describe("computeStats", () => {
  it("keeps the given habit order and routes each record to its own habit", () => {
    const habits = [CHECK, NUMERIC];
    const records = [
      { habit_id: CHECK.id, date: ago(0), value: 1 },
      { habit_id: CHECK.id, date: ago(1), value: 1 },
      { habit_id: NUMERIC.id, date: ago(0), value: 10 },
      { habit_id: NUMERIC.id, date: ago(1), value: 30 },
      // A habit not in the list (archived, say) must not leak into anyone else.
      { habit_id: 99, date: ago(0), value: 1 },
    ];

    const stats = computeStats(habits, records, TODAY);

    assert.deepEqual(
      stats.map((s) => s.habit_id),
      [CHECK.id, NUMERIC.id],
    );
    assert.equal(stats[0]?.current_streak, 2);
    // Today fell short of 30, so the run is yesterday's single day.
    assert.equal(stats[1]?.current_streak, 1);
    assert.equal(stats[1]?.achieved_days, 1);
  });

  it("returns a zeroed row for a habit with no records at all", () => {
    const stats = computeStats([CHECK], [], TODAY);

    assert.equal(stats.length, 1);
    assert.deepEqual(stats[0], {
      habit_id: CHECK.id,
      current_streak: 0,
      longest_streak: 0,
      achieved_days: 0,
      window_days: RATE_WINDOW_DAYS,
      achievement_rate: 0,
    });
  });

  it("returns an empty list when there are no habits", () => {
    assert.deepEqual(computeStats([], [], TODAY), []);
  });

  it("rejects a today that is not a calendar date", () => {
    assert.throws(() => computeStats([CHECK], [], "2026-02-31"), RangeError);
  });
});
