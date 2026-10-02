import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Habit } from "../../../shared/types.ts";
import { badgeCount, pendingHabits, reminderMessage } from "./reminder.ts";

/**
 * What counts as "not done yet", and what the screen says about it.
 *
 * Two properties carry the phase (AC-9.1, AC-9.2):
 *
 *  1. **The count agrees with `isAchieved()` on every kind of habit.** The table
 *     below is one row per branch of that rule — check, numeric with a goal,
 *     numeric without one, and the half-typed input that yields NaN. If any row
 *     disagreed, the icon would show a number the stats page contradicts.
 *  2. **Nothing to say means nothing is said.** A reminder that appears on every
 *     visit is a reminder that gets ignored, so "no habits" is silence rather
 *     than a status report about zero things.
 */

const NOW = "2026-03-15T09:00:00.000Z";

function habit(id: number, overrides: Partial<Habit> = {}): Habit {
  return {
    id,
    name: `習慣${id}`,
    kind: "boolean",
    target: null,
    unit: null,
    color: "blue",
    sort_order: id,
    archived_at: null,
    created_at: NOW,
    ...overrides,
  };
}

describe("pendingHabits", () => {
  it("treats a habit with no record at all as pending", () => {
    const habits = [habit(1), habit(2)];
    assert.deepEqual(
      pendingHabits(habits, {}).map((h) => h.id),
      [1, 2],
    );
  });

  it("agrees with isAchieved() on every kind of habit", () => {
    // One row per branch of the rule in shared/domain.ts. `pending` is what the
    // badge counts, so a disagreement here is a number the stats contradict.
    const cases: { habit: Habit; value: number | undefined; pending: boolean; why: string }[] = [
      { habit: habit(1), value: 1, pending: false, why: "check: 1 is done" },
      { habit: habit(1), value: 0, pending: true, why: "check: 0 is not done" },
      { habit: habit(1), value: undefined, pending: true, why: "check: no record" },
      {
        habit: habit(2, { kind: "numeric", target: 30, unit: "分" }),
        value: 30,
        pending: false,
        why: "numeric: exactly the goal is done",
      },
      {
        habit: habit(2, { kind: "numeric", target: 30, unit: "分" }),
        value: 29,
        pending: true,
        why: "numeric: short of the goal is not done",
      },
      {
        habit: habit(2, { kind: "numeric", target: 30, unit: "分" }),
        value: 31,
        pending: false,
        why: "numeric: past the goal is done",
      },
      {
        habit: habit(3, { kind: "numeric", target: null }),
        value: 1,
        pending: false,
        why: "numeric without a goal: anything above zero is done",
      },
      {
        habit: habit(3, { kind: "numeric", target: null }),
        value: 0,
        pending: true,
        why: "numeric without a goal: zero is not done",
      },
      {
        habit: habit(4, { kind: "numeric", target: 0 }),
        value: 0,
        pending: true,
        why: "a goal of zero falls back to 'did anything at all'",
      },
      {
        habit: habit(5, { kind: "numeric", target: 30 }),
        value: Number.NaN,
        pending: true,
        why: "a half-typed input is never an achievement",
      },
    ];

    for (const row of cases) {
      const values: Record<number, number> = {};
      if (row.value !== undefined) values[row.habit.id] = row.value;

      assert.equal(pendingHabits([row.habit], values).length, row.pending ? 1 : 0, row.why);
    }
  });

  it("keeps the order it was given", () => {
    const habits = [habit(7), habit(3), habit(5)];
    assert.deepEqual(
      pendingHabits(habits, {}).map((h) => h.id),
      [7, 3, 5],
    );
  });

  it("counts only the habits it was handed", () => {
    // Archived habits are split off by `useHabits` before they get here, and a
    // deleted habit must never be nagged about. Stated as a test so the split
    // cannot quietly move into this function.
    const listed = [habit(1)];
    const values = { 1: 0, 2: 0 };
    assert.equal(pendingHabits(listed, values).length, 1);
  });
});

describe("badgeCount", () => {
  it("is the number of pending habits", () => {
    assert.equal(badgeCount([]), 0);
    assert.equal(badgeCount([habit(1), habit(2)]), 2);
  });
});

describe("reminderMessage", () => {
  it("says nothing when there are no habits at all", () => {
    assert.equal(reminderMessage([], 0), null);
  });

  it("says everything is done when nothing is pending", () => {
    const message = reminderMessage([], 3);
    assert.equal(message, "今日の習慣はすべて達成しています。");
  });

  it("names a single pending habit", () => {
    const message = reminderMessage([habit(1, { name: "読書" })], 2);
    assert.equal(message, "今日はまだ 1 件未達成です（読書）。");
  });

  it("lists up to three names", () => {
    const pending = [
      habit(1, { name: "読書" }),
      habit(2, { name: "運動" }),
      habit(3, { name: "瞑想" }),
    ];
    assert.equal(reminderMessage(pending, 3), "今日はまだ 3 件未達成です（読書 / 運動 / 瞑想）。");
  });

  it("falls back to a count past three names", () => {
    const pending = [
      habit(1, { name: "読書" }),
      habit(2, { name: "運動" }),
      habit(3, { name: "瞑想" }),
      habit(4, { name: "日記" }),
      habit(5, { name: "散歩" }),
    ];
    assert.equal(
      reminderMessage(pending, 5),
      "今日はまだ 5 件未達成です（読書 / 運動 / 瞑想 ほか 2 件）。",
    );
  });

  it("never contains a line break", () => {
    // A newline in the source would arrive on screen as a stray space between
    // Japanese characters, which is why the sentence is built in this module
    // rather than in JSX.
    const pending = [habit(1, { name: "読書" }), habit(2, { name: "運動" })];
    for (const message of [reminderMessage(pending, 2), reminderMessage([], 2)]) {
      assert.ok(message !== null);
      assert.ok(!message.includes("\n"), `the message wrapped: ${JSON.stringify(message)}`);
    }
  });
});
