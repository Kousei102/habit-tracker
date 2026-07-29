import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DataError } from "../errors.ts";
import { STORAGE_KEY, SCHEMA_VERSION } from "./document.ts";
import type { StorageLike } from "./store.ts";
import * as store from "./store.ts";

/**
 * The `localStorage`-backed store, driven through a stand-in backend.
 *
 * The backend is the only browser thing this layer touches, so replacing it with
 * an object literal exercises the real read/write path — including the two
 * failures that matter and cannot be reproduced in a browser on demand: a full
 * quota and storage that refuses to work at all (AC-7.12).
 *
 * Everything here is written without `await` on purpose. That is the assertion
 * of AC-7.5: if the store were asynchronous, none of these lines would compile.
 */

/** A `localStorage` that lives in a Map. */
function memoryStorage(initial?: string): StorageLike & { raw(): string | null } {
  const items = new Map<string, string>();
  if (initial !== undefined) items.set(STORAGE_KEY, initial);

  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    raw: () => items.get(STORAGE_KEY) ?? null,
  };
}

/** A backend whose writes always fail the way a full browser's do. */
function fullStorage(initial: string | null): StorageLike & { raw(): string | null } {
  return {
    getItem: () => initial,
    setItem: () => {
      const error = new Error("QuotaExceededError") as Error & { name: string; code: number };
      error.name = "QuotaExceededError";
      error.code = 22;
      throw error;
    },
    raw: () => initial,
  };
}

afterEach(() => {
  store.setStorageBackend(null);
});

describe("round trip (AC-7.5)", () => {
  it("reads back what it wrote, synchronously", () => {
    const backend = memoryStorage();
    store.setStorageBackend(backend);

    const habit = store.createHabit({ name: "散歩", kind: "boolean" });
    store.putEntry(habit.id, "2026-03-15", 1);

    // No await anywhere: the value is already there on the next line.
    assert.deepEqual(store.getHabits().map((row) => row.name), ["散歩"]);
    assert.deepEqual(store.getEntries("2026-03-15", "2026-03-15"), [
      { habit_id: habit.id, date: "2026-03-15", value: 1 },
    ]);
    assert.equal(store.getStats("2026-03-15")[0]?.current_streak, 1);
  });

  it("survives a reload — a second reader of the same bytes sees the same app", () => {
    const backend = memoryStorage();
    store.setStorageBackend(backend);
    const habit = store.createHabit({ name: "読書", kind: "numeric", target: 30, unit: "分" });
    store.putEntry(habit.id, "2026-03-14", 45);

    // What a fresh page load does: nothing in memory, everything from the string.
    const reloaded = memoryStorage(backend.raw() ?? undefined);
    store.setStorageBackend(reloaded);

    assert.deepEqual(store.getHabits(), [
      {
        id: habit.id,
        name: "読書",
        kind: "numeric",
        target: 30,
        unit: "分",
        color: habit.color,
        sort_order: 0,
        archived_at: null,
        created_at: habit.created_at,
      },
    ]);
    assert.equal(store.getEntries("2026-03-14", "2026-03-14")[0]?.value, 45);
  });

  it("starts empty when nothing has ever been stored (AC-7.10)", () => {
    store.setStorageBackend(memoryStorage());

    assert.deepEqual(store.getHabits(), []);
    assert.deepEqual(store.getEntries("2020-01-01", "2030-01-01"), []);
    assert.deepEqual(store.getStats("2026-03-15"), []);
  });

  it("writes a versioned document (AC-7.6)", () => {
    const backend = memoryStorage();
    store.setStorageBackend(backend);
    store.createHabit({ name: "散歩", kind: "boolean" });

    const stored = JSON.parse(backend.raw() ?? "null") as Record<string, unknown>;
    assert.equal(stored["version"], SCHEMA_VERSION);
  });
});

describe("an unreadable document (AC-7.6)", () => {
  it("reports rather than throwing something unreadable at the screen", () => {
    store.setStorageBackend(memoryStorage("{ this is not json"));

    assert.throws(() => store.getHabits(), (cause: unknown) => {
      assert.ok(cause instanceof DataError);
      assert.equal(cause.code, "corrupt");
      return true;
    });
  });

  it("does not overwrite it — a write is refused before it reaches storage", () => {
    const backend = memoryStorage("{ this is not json");
    store.setStorageBackend(backend);

    assert.throws(() => store.createHabit({ name: "散歩", kind: "boolean" }), DataError);
    assert.throws(() => store.putEntry(1, "2026-03-15", 1), DataError);

    // The bytes the user still has are exactly the bytes they had.
    assert.equal(backend.raw(), "{ this is not json");
  });

  it("does not overwrite a document from a newer version either", () => {
    const future = JSON.stringify({ version: SCHEMA_VERSION + 1, habits: [], entries: {} });
    const backend = memoryStorage(future);
    store.setStorageBackend(backend);

    assert.throws(() => store.createHabit({ name: "散歩", kind: "boolean" }), DataError);
    assert.equal(backend.raw(), future);
  });
});

describe("storage that cannot be written (AC-7.12)", () => {
  it("turns a full quota into a readable Japanese message", () => {
    const backend = fullStorage(null);
    store.setStorageBackend(backend);

    assert.throws(() => store.createHabit({ name: "散歩", kind: "boolean" }), (cause: unknown) => {
      assert.ok(cause instanceof DataError, "the failure must not escape as a DOMException");
      assert.equal(cause.code, "quota");
      assert.notEqual(cause.message.trim(), "");
      // Nothing English on screen, and nothing that reads like a stack trace.
      assert.doesNotMatch(cause.message, /[A-Za-z]{4,}/);
      return true;
    });
  });

  it("leaves the previous document intact when a write fails", () => {
    // Written while storage still worked…
    const working = memoryStorage();
    store.setStorageBackend(working);
    const habit = store.createHabit({ name: "散歩", kind: "boolean" });
    const before = working.raw();

    // …and now it does not.
    const backend = fullStorage(before);
    store.setStorageBackend(backend);

    assert.throws(() => store.putEntry(habit.id, "2026-03-15", 1), DataError);
    assert.equal(backend.raw(), before);
    // The habit is still readable, so the screen shows the truth, not an empty app.
    assert.deepEqual(store.getHabits().map((row) => row.name), ["散歩"]);
  });

  it("says so when the browser refuses storage altogether", () => {
    store.setStorageBackend({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    });

    // Not a quota problem, but it must still arrive as a Japanese sentence
    // rather than as the browser's own exception.
    for (const act of [() => store.getHabits(), () => store.createHabit({ name: "散歩", kind: "boolean" })]) {
      assert.throws(act, (cause: unknown) => {
        assert.ok(cause instanceof DataError);
        assert.equal(cause.code, "unavailable");
        assert.doesNotMatch(cause.message, /[A-Za-z]{4,}/);
        return true;
      });
    }
  });
});

describe("logical delete through the store (AC-7.7)", () => {
  it("hides the habit but keeps its records in storage", () => {
    const backend = memoryStorage();
    store.setStorageBackend(backend);

    const habit = store.createHabit({ name: "散歩", kind: "boolean" });
    store.putEntry(habit.id, "2026-03-14", 1);
    store.deleteHabit(habit.id);

    assert.deepEqual(store.getHabits(), []);
    assert.equal(store.getHabits(true).length, 1);
    assert.equal(store.getEntries("2026-03-14", "2026-03-14").length, 1);

    // And it is genuinely on disk, not just in a list we happen to still hold.
    assert.match(backend.raw() ?? "", /2026-03-14/);
  });

  it("restores it with the records it kept", () => {
    store.setStorageBackend(memoryStorage());

    const habit = store.createHabit({ name: "散歩", kind: "boolean" });
    store.putEntry(habit.id, "2026-03-14", 1);
    store.deleteHabit(habit.id);
    store.restoreHabit(habit.id);

    assert.deepEqual(store.getHabits().map((row) => row.id), [habit.id]);
    assert.equal(store.getStats("2026-03-15")[0]?.longest_streak, 1);
  });
});

// ---------------------------------------------------------------------------
// Recovery (AC-8.12).
//
// These three are the only operations that do not read the document first, and
// that is exactly what makes them usable when it cannot be read. On an iPhone
// there is no devtools and no way to clear one site's storage, so if these did
// not work from inside a broken app, a broken app would be a dead one.
// ---------------------------------------------------------------------------

describe("recovery from an unreadable document (AC-8.12)", () => {
  const BROKEN = "{ this is not json";

  it("reports the problem through `probe` without throwing", () => {
    store.setStorageBackend(memoryStorage(BROKEN));

    const result = store.probe();
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.message.trim() !== "");
  });

  it("says nothing is wrong when nothing is", () => {
    store.setStorageBackend(memoryStorage());
    store.createHabit({ name: "散歩", kind: "boolean" });

    assert.deepEqual(store.probe(), { ok: true });
  });

  it("probing does not write — the broken bytes stay exactly as they were", () => {
    const backend = memoryStorage(BROKEN);
    store.setStorageBackend(backend);

    store.probe();
    store.probe();

    assert.equal(backend.raw(), BROKEN);
  });

  it("hands back the raw bytes so they can be rescued to a file", () => {
    store.setStorageBackend(memoryStorage(BROKEN));
    assert.equal(store.readRawDocument(), BROKEN);
  });

  it("replaces an unreadable document with an imported one", () => {
    const backend = memoryStorage(BROKEN);
    store.setStorageBackend(backend);

    // Ordinary writes are still refused…
    assert.throws(() => store.createHabit({ name: "散歩", kind: "boolean" }), DataError);

    // …but an import, which the user explicitly confirmed, goes through.
    store.replaceAll({
      version: SCHEMA_VERSION,
      next_habit_id: 2,
      habits: [
        {
          id: 1,
          name: "復元した習慣",
          kind: "boolean",
          target: null,
          unit: null,
          color: "blue",
          sort_order: 0,
          archived_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      entries: { "1": { "2026-03-14": 1 } },
    });

    assert.deepEqual(store.probe(), { ok: true });
    assert.deepEqual(store.getHabits().map((habit) => habit.name), ["復元した習慣"]);
    assert.equal(store.getEntries("2026-03-14", "2026-03-14").length, 1);
    // And the app can be used again straight afterwards.
    assert.doesNotThrow(() => store.createHabit({ name: "新しい習慣", kind: "boolean" }));
  });

  it("resets an unreadable document to an empty one", () => {
    const backend = memoryStorage(BROKEN);
    store.setStorageBackend(backend);

    store.resetAll();

    assert.deepEqual(store.probe(), { ok: true });
    assert.deepEqual(store.getHabits(true), []);
    // An empty *document*, not an absent key: a version the app understands.
    const stored = JSON.parse(backend.raw() ?? "null") as { version: number };
    assert.equal(stored.version, SCHEMA_VERSION);

    assert.doesNotThrow(() => store.createHabit({ name: "やり直し", kind: "boolean" }));
  });

  it("reports a reset that could not be written instead of pretending", () => {
    store.setStorageBackend(fullStorage(BROKEN));
    assert.throws(() => store.resetAll(), DataError);
  });
});

describe("the last export date (AC-8.9)", () => {
  it("is absent until there has been one", () => {
    store.setStorageBackend(memoryStorage());
    assert.equal(store.getLastExportDate(), null);
  });

  it("round-trips the day it was told", () => {
    store.setStorageBackend(memoryStorage());
    store.setLastExportDate("2026-03-15");
    assert.equal(store.getLastExportDate(), "2026-03-15");
  });

  it("lives outside the document, so it survives an unreadable one", () => {
    const backend = memoryStorage("{ this is not json");
    store.setStorageBackend(backend);

    store.setLastExportDate("2026-03-15");

    assert.equal(store.getLastExportDate(), "2026-03-15");
    // …and writing it did not touch the document being protected.
    assert.equal(backend.raw(), "{ this is not json");
  });

  it("ignores a stored value that is not a date", () => {
    const backend = memoryStorage();
    backend.setItem("habit-tracker.last-export", "きのう");
    store.setStorageBackend(backend);

    assert.equal(store.getLastExportDate(), null);
  });

  it("refuses to record a day that is not a day", () => {
    const backend = memoryStorage();
    store.setStorageBackend(backend);

    store.setLastExportDate("2026-13-40");
    assert.equal(store.getLastExportDate(), null);
  });

  it("does not fail the export when it cannot be recorded", () => {
    // The file has already reached the user by then. Failing the whole export
    // over a note about it would be the tail wagging the dog.
    store.setStorageBackend({
      getItem: () => null,
      setItem: () => {
        throw new Error("nope");
      },
    });

    assert.doesNotThrow(() => store.setLastExportDate("2026-03-15"));
  });
});
