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
