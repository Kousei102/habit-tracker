import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppData } from "./document.ts";
import {
  SCHEMA_VERSION,
  archiveHabit,
  computeAllStats,
  createHabit,
  emptyData,
  findHabit,
  listEntries,
  listHabits,
  parse,
  putEntry,
  restoreHabit,
  serialize,
  updateHabit,
} from "./document.ts";
import { DataError } from "../errors.ts";

/**
 * The stored document, tested where it is pure.
 *
 * Splitting the model out of `store.ts` is what makes this possible at all:
 * everything below runs in `node:test` with no browser, which is where AC-7.5
 * (a synchronous round trip) and AC-7.6 (version handling that never destroys
 * data) actually get proved.
 */

const NOW = "2026-03-15T09:00:00.000Z";

/** A document with one check habit and one numeric habit. */
function seeded(): AppData {
  let data = emptyData();
  data = createHabit(data, { name: "散歩", kind: "boolean" }, NOW).data;
  data = createHabit(data, { name: "読書", kind: "numeric", target: 30, unit: "分" }, NOW).data;
  return data;
}

describe("serialize / parse", () => {
  it("round-trips a document unchanged (AC-7.5)", () => {
    let data = seeded();
    data = putEntry(data, 1, "2026-03-15", 1).data;
    data = putEntry(data, 2, "2026-03-14", 45).data;

    const result = parse(serialize(data));

    assert.equal(result.status, "ok");
    assert.deepEqual(result.status === "ok" ? result.data : null, data);
  });

  it("writes the schema version into the document (AC-7.6)", () => {
    const stored = JSON.parse(serialize(emptyData())) as Record<string, unknown>;
    assert.equal(stored["version"], SCHEMA_VERSION);
  });

  it("treats absent, empty and whitespace-only storage as a fresh start", () => {
    for (const text of [null, undefined, "", "   "]) {
      const result = parse(text);
      assert.equal(result.status, "empty", `text=${JSON.stringify(text)}`);
      assert.deepEqual(result.status === "empty" ? result.data : null, emptyData());
    }
  });

  it("reports broken JSON instead of throwing, and hands back no data (AC-7.6)", () => {
    for (const text of ["{", "not json", "[1,2,3]", '"a string"', "null"]) {
      const result = parse(text);
      assert.equal(result.status, "unreadable", `text=${JSON.stringify(text)}`);
      if (result.status !== "unreadable") continue;
      assert.ok(result.error instanceof DataError);
      assert.equal(result.error.code, "corrupt");
      // Whatever is on screen has to be a sentence, not a stack trace.
      assert.notEqual(result.error.message.trim(), "");
    }
  });

  it("refuses a document from a newer version rather than rewriting it (AC-7.6)", () => {
    const future = JSON.stringify({ ...emptyData(), version: SCHEMA_VERSION + 1, habits: [] });

    const result = parse(future);

    assert.equal(result.status, "unreadable");
    // The caller's contract: `unreadable` carries no `data`, so there is nothing
    // to save back over the newer document. That is the whole protection.
    assert.equal("data" in result, false);
    if (result.status === "unreadable") assert.match(result.error.message, /更新/);
  });

  it("refuses a document whose version is missing or nonsense", () => {
    for (const version of [undefined, null, "1", 0, -1, 1.5]) {
      const text = JSON.stringify({ version, next_habit_id: 1, habits: [], entries: {} });
      assert.equal(parse(text).status, "unreadable", `version=${JSON.stringify(version)}`);
    }
  });

  it("refuses a v1 document with structurally wrong contents", () => {
    const cases: unknown[] = [
      { version: 1, habits: {}, entries: {} },
      { version: 1, habits: [], entries: [] },
      { version: 1, habits: [{ id: "x", name: "a", kind: "boolean" }], entries: {} },
      { version: 1, habits: [{ id: 1, name: "a", kind: "counter" }], entries: {} },
      { version: 1, habits: [], entries: { abc: { "2026-03-15": 1 } } },
      { version: 1, habits: [], entries: { "1": { "2026-13-40": 1 } } },
      { version: 1, habits: [], entries: { "1": { "2026-03-15": "1" } } },
    ];

    for (const candidate of cases) {
      assert.equal(parse(JSON.stringify(candidate)).status, "unreadable", JSON.stringify(candidate));
    }
  });

  it("keeps a document readable when only the id counter is missing", () => {
    // Derivable from the ids present, so failing the whole document over it would
    // lose data that is plainly intact.
    const text = JSON.stringify({
      version: 1,
      habits: [{ id: 7, name: "散歩", kind: "boolean", target: null, unit: null, color: "blue", sort_order: 0, archived_at: null, created_at: NOW }],
      entries: {},
    });

    const result = parse(text);

    assert.equal(result.status, "ok");
    // Never below max(id) + 1: a reused id would attach old entries to a new habit.
    if (result.status === "ok") assert.equal(result.data.next_habit_id, 8);
  });
});

describe("createHabit", () => {
  it("hands out increasing ids that are never reused after a delete", () => {
    let data = emptyData();
    const first = createHabit(data, { name: "A", kind: "boolean" }, NOW);
    data = first.data;
    data = archiveHabit(data, first.habit.id, NOW).data;
    const second = createHabit(data, { name: "B", kind: "boolean" }, NOW);

    assert.equal(first.habit.id, 1);
    assert.equal(second.habit.id, 2);
  });

  it("stores a numeric habit's goal and unit, and strips both from a check habit", () => {
    let data = emptyData();
    const numeric = createHabit(data, { name: "読書", kind: "numeric", target: 30, unit: "分" }, NOW);
    data = numeric.data;
    const check = createHabit(data, { name: "散歩", kind: "boolean", target: 30, unit: "分" }, NOW);

    assert.equal(numeric.habit.target, 30);
    assert.equal(numeric.habit.unit, "分");
    assert.equal(check.habit.target, null);
    assert.equal(check.habit.unit, null);
  });

  it("rejects a blank name with a message the form can show", () => {
    assert.throws(() => createHabit(emptyData(), { name: "  ", kind: "boolean" }, NOW), (cause: unknown) => {
      assert.ok(cause instanceof DataError);
      assert.equal(cause.code, "validation");
      assert.match(cause.message, /習慣名/);
      return true;
    });
  });

  it("rejects a target that is zero or negative", () => {
    for (const target of [0, -1]) {
      assert.throws(
        () => createHabit(emptyData(), { name: "読書", kind: "numeric", target }, NOW),
        DataError,
        `target=${target}`,
      );
    }
  });

  it("does not mutate the document it was given", () => {
    const before = emptyData();
    const snapshot = serialize(before);
    createHabit(before, { name: "A", kind: "boolean" }, NOW);
    assert.equal(serialize(before), snapshot);
  });
});

describe("updateHabit", () => {
  it("changes the name and the goal", () => {
    const data = seeded();
    const { habit } = updateHabit(data, 2, { name: "読書（夜）", target: 45 });

    assert.equal(habit.name, "読書（夜）");
    assert.equal(habit.target, 45);
  });

  it("clears the goal on an explicit null but keeps it when the field is absent", () => {
    const data = seeded();

    assert.equal(updateHabit(data, 2, { target: null }).habit.target, null);
    assert.equal(updateHabit(data, 2, { name: "読書" }).habit.target, 30);
  });

  it("refuses an id that does not exist, or one that has been deleted", () => {
    const data = archiveHabit(seeded(), 1, NOW).data;

    assert.throws(() => updateHabit(data, 999, { name: "x" }), DataError);
    assert.throws(() => updateHabit(data, 1, { name: "x" }), DataError);
  });
});

describe("archiveHabit / restoreHabit", () => {
  it("keeps every entry of a deleted habit (AC-7.7)", () => {
    let data = seeded();
    data = putEntry(data, 1, "2026-03-14", 1).data;
    data = putEntry(data, 1, "2026-03-15", 1).data;

    data = archiveHabit(data, 1, NOW).data;

    // Gone from the list…
    assert.deepEqual(listHabits(data).map((habit) => habit.id), [2]);
    // …still in the document, which is what Phase 8's export will read.
    assert.equal(listEntries(data).filter((entry) => entry.habit_id === 1).length, 2);
    assert.equal(findHabit(data, 1)?.archived_at, NOW);
  });

  it("lists a deleted habit again when asked for archived ones, active first", () => {
    const data = archiveHabit(seeded(), 1, NOW).data;
    assert.deepEqual(listHabits(data, true).map((habit) => habit.id), [2, 1]);
  });

  it("brings a deleted habit back with its records", () => {
    let data = putEntry(seeded(), 1, "2026-03-15", 1).data;
    data = archiveHabit(data, 1, NOW).data;
    data = restoreHabit(data, 1).data;

    assert.equal(findHabit(data, 1)?.archived_at, null);
    assert.equal(listEntries(data).filter((entry) => entry.habit_id === 1).length, 1);
  });

  it("refuses to delete twice, or to restore something that was never deleted", () => {
    const data = archiveHabit(seeded(), 1, NOW).data;

    assert.throws(() => archiveHabit(data, 1, NOW), DataError);
    assert.throws(() => restoreHabit(data, 2), DataError);
  });
});

describe("putEntry", () => {
  it("overwrites the same day rather than adding a second record", () => {
    let data = putEntry(seeded(), 2, "2026-03-15", 10).data;
    data = putEntry(data, 2, "2026-03-15", 40).data;

    const entries = listEntries(data);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { habit_id: 2, date: "2026-03-15", value: 40 });
  });

  it("stores an explicit zero instead of deleting the record", () => {
    // A day the user marked as not done is a day they turned up for, and the
    // heatmap paints it differently from a blank day (AC-5.2).
    const data = putEntry(seeded(), 1, "2026-03-15", 0).data;
    assert.deepEqual(listEntries(data), [{ habit_id: 1, date: "2026-03-15", value: 0 }]);
  });

  it("refuses an unknown or deleted habit, and a date that is not YYYY-MM-DD", () => {
    const data = archiveHabit(seeded(), 1, NOW).data;

    assert.throws(() => putEntry(data, 999, "2026-03-15", 1), DataError);
    assert.throws(() => putEntry(data, 1, "2026-03-15", 1), DataError);
    assert.throws(() => putEntry(data, 2, "15/03/2026", 1), DataError);
    assert.throws(() => putEntry(data, 2, "2026-02-31", 1), DataError);
  });
});

describe("listEntries", () => {
  it("returns records in date then habit order, clipped to the range", () => {
    let data = seeded();
    data = putEntry(data, 2, "2026-03-13", 30).data;
    data = putEntry(data, 1, "2026-03-14", 1).data;
    data = putEntry(data, 2, "2026-03-14", 30).data;
    data = putEntry(data, 1, "2026-03-15", 1).data;

    assert.deepEqual(
      listEntries(data, "2026-03-14", "2026-03-14").map((entry) => [entry.date, entry.habit_id]),
      [
        ["2026-03-14", 1],
        ["2026-03-14", 2],
      ],
    );
    assert.equal(listEntries(data, "2026-03-13", "2026-03-15").length, 4);
    assert.equal(listEntries(data).length, 4);
  });
});

describe("computeAllStats", () => {
  it("counts an unbroken run that ends yesterday when today is not done yet", () => {
    // The rule the whole app is built around: an unfinished today is not a
    // broken day. The maths itself lives in shared/stats.ts; this checks that the
    // document hands it the right rows.
    let data = seeded();
    for (const date of ["2026-03-12", "2026-03-13", "2026-03-14"]) {
      data = putEntry(data, 1, date, 1).data;
    }

    const stats = computeAllStats(data, "2026-03-15");
    assert.equal(stats.find((row) => row.habit_id === 1)?.current_streak, 3);
  });

  it("does not count a numeric day below its goal", () => {
    const data = putEntry(seeded(), 2, "2026-03-15", 29).data;
    assert.equal(computeAllStats(data, "2026-03-15").find((row) => row.habit_id === 2)?.achieved_days, 0);
  });

  it("leaves deleted habits out, and their records with them", () => {
    let data = putEntry(seeded(), 1, "2026-03-15", 1).data;
    data = archiveHabit(data, 1, NOW).data;

    const stats = computeAllStats(data, "2026-03-15");
    assert.deepEqual(stats.map((row) => row.habit_id), [2]);
  });

  it("answers zeroes for a habit with no records at all", () => {
    const stats = computeAllStats(seeded(), "2026-03-15");
    assert.deepEqual(stats.map((row) => row.current_streak), [0, 0]);
    assert.deepEqual(stats.map((row) => row.achievement_rate), [0, 0]);
  });

  it("refuses a today that is not a calendar day", () => {
    assert.throws(() => computeAllStats(seeded(), "2026-3-15"), DataError);
  });
});
