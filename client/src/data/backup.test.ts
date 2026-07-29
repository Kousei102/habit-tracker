import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  buildExport,
  daysBetween,
  exportFilename,
  exportReminder,
  parseImport,
  serializeExport,
  summarize,
} from "./backup.ts";
import type { AppData } from "./document.ts";
import {
  SCHEMA_VERSION,
  archiveHabit,
  createHabit,
  emptyData,
  listHabits,
  parse,
  putEntry,
  serialize,
} from "./document.ts";

/**
 * The backup format, where it is pure.
 *
 * Two properties carry the whole phase and are worth stating plainly:
 *
 *  1. **Export → import is lossless**, deleted habits included (AC-8.5, AC-8.6).
 *  2. **No input produces a document unless every field checked out** (AC-8.8).
 *     That is why the broken-input table below is long: "existing data is not
 *     destroyed" is only as strong as the set of inputs that fail to parse, and
 *     the only honest way to state it is one row per way a file can be wrong.
 */

const NOW = "2026-03-15T09:00:00.000Z";
const EXPORTED_AT = "2026-03-15T09:30:00.000Z";

/** One check habit, one numeric habit, one deleted habit — each with records. */
function seeded(): AppData {
  let data = emptyData();
  data = createHabit(data, { name: "散歩", kind: "boolean" }, NOW).data;
  data = createHabit(data, { name: "読書", kind: "numeric", target: 30, unit: "分" }, NOW).data;
  data = createHabit(data, { name: "やめた習慣", kind: "boolean" }, NOW).data;

  data = putEntry(data, 1, "2026-03-14", 1).data;
  data = putEntry(data, 1, "2026-03-15", 1).data;
  data = putEntry(data, 2, "2026-03-15", 45).data;
  data = putEntry(data, 3, "2026-01-02", 1).data;

  // Deleted *after* it was recorded, which is the case the export has to keep.
  data = archiveHabit(data, 3, NOW).data;
  return data;
}

describe("buildExport (AC-8.5)", () => {
  it("includes deleted habits and their records", () => {
    const data = seeded();
    const file = buildExport(data, EXPORTED_AT);

    const archived = file.habits.find((habit) => habit.name === "やめた習慣");
    assert.ok(archived, "the deleted habit was dropped from the export");
    assert.notEqual(archived.archived_at, null);

    const itsRecords = file.entries.filter((entry) => entry.habit_id === archived.id);
    assert.deepEqual(itsRecords, [{ habit_id: 3, date: "2026-01-02", value: 1 }]);

    // And the export is not merely "what the dashboard shows": the dashboard
    // lists two habits, the file carries three.
    assert.equal(listHabits(data).length, 2);
    assert.equal(file.habits.length, 3);
  });

  it("carries every record, once each", () => {
    const file = buildExport(seeded(), EXPORTED_AT);
    assert.equal(file.entries.length, 4);

    const keys = file.entries.map((entry) => `${entry.habit_id}:${entry.date}`);
    assert.equal(new Set(keys).size, keys.length, "a record was duplicated");
  });

  it("marks the file as this app's, with a version of its own", () => {
    const file = buildExport(emptyData(), EXPORTED_AT);

    assert.equal(file.format, EXPORT_FORMAT);
    assert.equal(file.format_version, EXPORT_FORMAT_VERSION);
    // The *storage* version travels too, but separately: the file format is
    // meant to outlive the storage format.
    assert.equal(file.app_schema_version, SCHEMA_VERSION);
    assert.equal(file.exported_at, EXPORTED_AT);
  });

  it("is stable — the same data exports to the same bytes", () => {
    const data = seeded();
    assert.equal(
      serializeExport(buildExport(data, EXPORTED_AT)),
      serializeExport(buildExport(data, EXPORTED_AT)),
    );
  });

  it("does not read a clock: the timestamp is the one it was given", () => {
    const file = buildExport(emptyData(), "1999-01-01T00:00:00.000Z");
    assert.equal(file.exported_at, "1999-01-01T00:00:00.000Z");
  });
});

describe("exportFilename", () => {
  it("puts the day in the name so backups form generations", () => {
    assert.equal(exportFilename("2026-07-29"), "habit-tracker-2026-07-29.json");
  });

  it("still produces a usable name if handed nonsense", () => {
    for (const bad of ["", "yesterday", "2026-13-40"]) {
      assert.match(exportFilename(bad), /^habit-tracker-.*\.json$/);
    }
  });
});

describe("round trip (AC-8.6)", () => {
  it("restores the document exactly, from an export of it", () => {
    const original = seeded();
    const text = serializeExport(buildExport(original, EXPORTED_AT));

    const result = parseImport(text);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    assert.deepEqual(result.data, original);
  });

  it("restores it on top of nothing — the 'wiped the device' case", () => {
    const original = seeded();
    const text = serializeExport(buildExport(original, EXPORTED_AT));

    // What the app does after a reset: an empty document, then the file.
    const wiped = emptyData();
    assert.deepEqual(wiped.habits, []);

    const result = parseImport(text);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    // Not just equal in memory: the restored document survives being stored and
    // read back, which is the path the app actually takes.
    const reread = parse(serialize(result.data));
    assert.equal(reread.status, "ok");
    assert.deepEqual(reread.status === "ok" ? reread.data : null, original);
  });

  it("keeps the id counter from going backwards", () => {
    let data = seeded();
    // Three habits created, so the next id is 4 even though ids 1..3 are in use.
    assert.equal(data.next_habit_id, 4);

    data = { ...data, next_habit_id: 99 };
    const result = parseImport(serializeExport(buildExport(data, EXPORTED_AT)));
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.data.next_habit_id : 0, 99);
  });

  it("repairs a missing counter rather than refusing the file", () => {
    const file = buildExport(seeded(), EXPORTED_AT) as unknown as Record<string, unknown>;
    delete file["next_habit_id"];

    const result = parseImport(JSON.stringify(file));
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.data.next_habit_id : 0, 4);
  });

  it("summarises what it read (AC-8.7)", () => {
    const result = parseImport(serializeExport(buildExport(seeded(), EXPORTED_AT)));
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    assert.deepEqual(result.summary, {
      habitCount: 3,
      archivedCount: 1,
      entryCount: 4,
      firstDate: "2026-01-02",
      lastDate: "2026-03-15",
    });
  });

  it("summarises an empty backup without inventing a range", () => {
    const result = parseImport(serializeExport(buildExport(emptyData(), EXPORTED_AT)));
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    assert.deepEqual(result.summary, {
      habitCount: 0,
      archivedCount: 0,
      entryCount: 0,
      firstDate: null,
      lastDate: null,
    });
  });
});

describe("summarize", () => {
  it("counts deleted habits separately", () => {
    const summary = summarize(buildExport(seeded(), EXPORTED_AT));
    assert.equal(summary.habitCount, 3);
    assert.equal(summary.archivedCount, 1);
  });
});

// ---------------------------------------------------------------------------
// AC-8.8 — the table this file exists for.
//
// Every row must come back as an error *with a sentence*, and — because
// `parseImport` writes nothing and returns no document — the caller has nothing
// it could apply. That is the mechanism by which "a broken file does not damage
// existing data" holds: there is no partial result to apply.
// ---------------------------------------------------------------------------

function good(): Record<string, unknown> {
  return JSON.parse(serializeExport(buildExport(seeded(), EXPORTED_AT))) as Record<string, unknown>;
}

/** The good file with one field replaced (or removed, with `undefined`). */
function tweak(field: string, value: unknown): string {
  const file = good();
  if (value === undefined) delete file[field];
  else file[field] = value;
  return JSON.stringify(file);
}

describe("parseImport refuses broken input (AC-8.8)", () => {
  const broken: Array<{ label: string; text: string }> = [
    { label: "an empty string", text: "" },
    { label: "whitespace only", text: "   \n " },
    { label: "truncated JSON", text: '{"format":"habit-tracker-export","format_ver' },
    { label: "not JSON at all", text: "これは JSON ではありません" },
    { label: "a JSON array", text: "[1,2,3]" },
    { label: "a JSON string", text: '"habit-tracker-export"' },
    { label: "JSON null", text: "null" },
    { label: "a number", text: "42" },

    { label: "another app's export", text: JSON.stringify({ todos: [{ title: "牛乳", done: false }] }) },
    {
      label: "a plausible impostor with habits but no marker",
      text: JSON.stringify({ habits: [{ id: 1, name: "散歩", kind: "boolean" }], entries: [] }),
    },
    {
      label: "the app's own *storage* document rather than an export",
      // Real data, wrong file: it has no `format`, and its `entries` is an
      // object. Importing it by accident would be silent data loss.
      text: serialize(seeded()),
    },

    { label: "no format marker", text: tweak("format", undefined) },
    { label: "the wrong format marker", text: tweak("format", "some-other-app") },
    { label: "a numeric format marker", text: tweak("format", 1) },

    { label: "no format version", text: tweak("format_version", undefined) },
    { label: "a format version from the future", text: tweak("format_version", EXPORT_FORMAT_VERSION + 1) },
    { label: "a format version of zero", text: tweak("format_version", 0) },
    { label: "a fractional format version", text: tweak("format_version", 1.5) },
    { label: "a format version as a string", text: tweak("format_version", "1") },

    { label: "no habits array", text: tweak("habits", undefined) },
    { label: "habits as an object", text: tweak("habits", { "1": "散歩" }) },
    { label: "a habit that is a string", text: tweak("habits", ["散歩"]) },
    { label: "a habit that is null", text: tweak("habits", [null]) },
    { label: "a habit with no id", text: tweak("habits", [{ name: "散歩", kind: "boolean" }]) },
    { label: "a habit with a string id", text: tweak("habits", [{ id: "1", name: "散歩", kind: "boolean" }]) },
    { label: "a habit with id 0", text: tweak("habits", [{ id: 0, name: "散歩", kind: "boolean" }]) },
    { label: "a habit with a negative id", text: tweak("habits", [{ id: -1, name: "散歩", kind: "boolean" }]) },
    { label: "a habit with an unknown kind", text: tweak("habits", [{ id: 1, name: "散歩", kind: "weekly" }]) },
    { label: "a habit with no name", text: tweak("habits", [{ id: 1, kind: "boolean" }]) },
    { label: "a habit with a NaN target", text: tweak("habits", [{ id: 1, name: "読書", kind: "numeric", target: "30" }]) },
    {
      label: "two habits sharing an id",
      text: tweak("habits", [
        { id: 1, name: "散歩", kind: "boolean" },
        { id: 1, name: "読書", kind: "boolean" },
      ]),
    },

    { label: "no entries array", text: tweak("entries", undefined) },
    { label: "entries as an object", text: tweak("entries", { "1": { "2026-03-15": 1 } }) },
    { label: "an entry that is a string", text: tweak("entries", ["2026-03-15"]) },
    { label: "an entry that is null", text: tweak("entries", [null]) },
    { label: "an entry with no date", text: tweak("entries", [{ habit_id: 1, value: 1 }]) },
    { label: "an entry with a malformed date", text: tweak("entries", [{ habit_id: 1, date: "15/03/2026", value: 1 }]) },
    { label: "an entry on the 31st of February", text: tweak("entries", [{ habit_id: 1, date: "2026-02-31", value: 1 }]) },
    { label: "an entry with a string value", text: tweak("entries", [{ habit_id: 1, date: "2026-03-15", value: "1" }]) },
    { label: "an entry with a null value", text: tweak("entries", [{ habit_id: 1, date: "2026-03-15", value: null }]) },
    { label: "an entry with no habit", text: tweak("entries", [{ date: "2026-03-15", value: 1 }]) },
    { label: "an entry with a fractional habit id", text: tweak("entries", [{ habit_id: 1.5, date: "2026-03-15", value: 1 }]) },
  ];

  for (const variant of broken) {
    it(`refuses ${variant.label}`, () => {
      const result = parseImport(variant.text);

      assert.equal(result.status, "error", `${variant.label} was accepted`);
      if (result.status !== "error") return;

      // A sentence the user can act on — not a stack trace, and not English.
      assert.notEqual(result.message.trim(), "");
      assert.doesNotMatch(result.message, /SyntaxError|JSON\.parse|undefined/);
    });
  }

  it("control: the good file this table mutates is itself accepted", () => {
    // Without this, every row above would also pass against a `parseImport` that
    // rejected everything.
    const result = parseImport(JSON.stringify(good()));
    assert.equal(result.status, "ok");
  });

  it("returns no document at all when it refuses", () => {
    const result = parseImport("{");
    assert.equal(result.status, "error");
    // There is nothing on the error branch to write, by construction: this is
    // what makes "existing data is untouched" a property of the types rather
    // than of the caller's discipline.
    assert.ok(!Object.hasOwn(result, "data"));
  });
});

describe("parseImport is tolerant where tolerance costs nothing", () => {
  it("ignores fields it does not know about", () => {
    const file = good();
    file["exported_by"] = "some future version";
    file["notes"] = { anything: true };

    const result = parseImport(JSON.stringify(file));
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.data.habits.length : 0, 3);
  });

  it("keeps records whose habit is missing rather than dropping them", () => {
    // A restore must never lose rows. They are invisible until a habit with that
    // id exists, but they are still in the document — and still in the next
    // export.
    const file = good();
    file["habits"] = [];
    file["entries"] = [{ habit_id: 7, date: "2026-03-15", value: 1 }];

    const result = parseImport(JSON.stringify(file));
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    assert.deepEqual(result.data.entries, { "7": { "2026-03-15": 1 } });
    assert.equal(result.summary.entryCount, 1);
  });

  it("lets the last of two records for the same day win", () => {
    const file = good();
    file["habits"] = [{ id: 1, name: "散歩", kind: "boolean", target: null, unit: null, color: "blue", sort_order: 0, archived_at: null, created_at: NOW }];
    file["entries"] = [
      { habit_id: 1, date: "2026-03-15", value: 1 },
      { habit_id: 1, date: "2026-03-15", value: 0 },
    ];

    const result = parseImport(JSON.stringify(file));
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    assert.equal(result.data.entries["1"]?.["2026-03-15"], 0);
    // Counted once, because it is one day.
    assert.equal(result.summary.entryCount, 1);
  });

  it("accepts a value of zero — 'did not do it' is a record", () => {
    const file = good();
    file["entries"] = [{ habit_id: 1, date: "2026-03-15", value: 0 }];

    const result = parseImport(JSON.stringify(file));
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.data.entries["1"]?.["2026-03-15"] : null, 0);
  });
});

// ---------------------------------------------------------------------------
// The nudge (AC-8.9)
// ---------------------------------------------------------------------------

describe("daysBetween", () => {
  it("counts whole days", () => {
    assert.equal(daysBetween("2026-03-01", "2026-03-31"), 30);
    assert.equal(daysBetween("2026-03-15", "2026-03-15"), 0);
  });

  it("crosses months and years", () => {
    assert.equal(daysBetween("2025-12-31", "2026-01-01"), 1);
    assert.equal(daysBetween("2024-02-28", "2024-03-01"), 2); // a leap year
  });

  it("never goes negative, and never throws on nonsense", () => {
    assert.equal(daysBetween("2026-03-15", "2026-03-01"), 0);
    assert.equal(daysBetween("nope", "2026-03-15"), 0);
    assert.equal(daysBetween("2026-03-15", ""), 0);
  });
});

describe("exportReminder", () => {
  it("says nothing when there is nothing to lose", () => {
    assert.equal(exportReminder(null, "2026-03-15", false), null);
    assert.equal(exportReminder("2020-01-01", "2026-03-15", false), null);
  });

  it("says something once there is data and no backup", () => {
    const message = exportReminder(null, "2026-03-15", true);
    assert.ok(message !== null && message.length > 0);
  });

  it("stays quiet after a recent export", () => {
    // The whole point: an app that warns every visit gets its warnings ignored.
    assert.equal(exportReminder("2026-03-15", "2026-03-15", true), null);
    assert.equal(exportReminder("2026-03-01", "2026-03-15", true), null);
    assert.equal(exportReminder("2026-02-15", "2026-03-15", true), null); // 28 days
  });

  it("speaks up once the backup is a month old", () => {
    const message = exportReminder("2026-02-13", "2026-03-15", true); // 30 days
    assert.ok(message !== null, "a month-old backup should be mentioned");
    assert.match(message, /30/);
  });

  it("does not throw on a nonsense date", () => {
    assert.equal(exportReminder("not-a-date", "2026-03-15", true), null);
    assert.equal(exportReminder("2026-03-01", "not-a-date", true), null);
  });
});
