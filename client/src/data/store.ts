import type {
  CreateHabitInput,
  Entry,
  Habit,
  HabitStats,
  UpdateHabitInput,
} from "../../../shared/types.ts";
import { isQuotaExceeded, quotaError, unavailableError } from "../errors.ts";
import type { AppData } from "./document.ts";
import * as doc from "./document.ts";
import { STORAGE_KEY } from "./document.ts";

/**
 * The app's data, backed by `localStorage`.
 *
 * **Synchronous, all the way through** (AC-7.5). `localStorage` is a synchronous
 * API, exactly like the `node:sqlite` calls this replaces, so the callers keep
 * their shape: a write returns the stored value, not a promise of it. Wrapping
 * this in `async` would buy nothing and cost every component a loading state for
 * an operation that cannot take longer than a JSON parse.
 *
 * Everything that decides anything lives in `document.ts` as pure functions. This
 * file is the part that touches the browser: read a string, write a string, and
 * turn the two ways that can fail into something a user can read.
 */

/**
 * The slice of `Storage` this module uses — two methods, so a test can supply an
 * object literal. Nothing here ever *removes* the key: the app has no "delete
 * everything" action, and until Phase 8 adds an export there is nothing to
 * restore from if it did.
 */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

let injected: StorageLike | null = null;

/**
 * Points the store at another backend, or back at `localStorage` with `null`.
 *
 * This is what lets `node:test` exercise the real read/write path — including the
 * quota failure, which is otherwise only reachable by filling up a browser.
 */
export function setStorageBackend(backend: StorageLike | null): void {
  injected = backend;
  // Swapping the backend is the test's way of saying "this is a fresh page
  // load", so the parsed document goes with it. Without this a test could not
  // tell a real round trip through the stored string from a cache hit.
  cache = null;
}

function storage(): StorageLike {
  if (injected !== null) return injected;

  // Merely *touching* `localStorage` throws when a browser is configured to
  // block site data, so the access itself has to be guarded — not just the calls.
  try {
    const local = globalThis.localStorage;
    if (local === undefined || local === null) throw new Error("localStorage is not available");
    return local;
  } catch {
    throw unavailableError();
  }
}

/**
 * The last document we parsed, together with the exact string it came from.
 *
 * Reading is cheap but not free: at five years of history (AC-7.11) the stored
 * string is ~280k characters, and validating it takes about 35 ms while
 * comparing it to a string we have already validated takes about 1 ms. Recording
 * a habit performs several reads — the write itself, the reload, the stats — and
 * paying the full price for each of them is what would make the app feel slow
 * once it holds a few years.
 *
 * **Keyed on the string, not on "we wrote it last".** A cache that assumed it was
 * the only writer would serve stale data to a second tab; this one re-reads
 * `localStorage` every time and only skips the *parse* when the bytes are
 * byte-for-byte what it already parsed. There is no state it can be wrong about.
 */
let cache: { text: string | null; data: AppData } | null = null;

/**
 * The saved document.
 *
 * Throws a `DataError` when the stored bytes cannot be understood, and every
 * write below starts by calling this — so an unreadable document stops writes
 * before they happen rather than being overwritten by them (AC-7.6).
 */
export function load(): AppData {
  let text: string | null;
  try {
    text = storage().getItem(STORAGE_KEY);
  } catch (cause) {
    // Some browsers expose `localStorage` and then throw on use rather than on
    // access. Same situation, same sentence — and still not a silent failure.
    console.error("[store] could not read from localStorage:", cause);
    throw unavailableError();
  }

  if (cache !== null && cache.text === text) return cache.data;

  const result = doc.parse(text);
  // An unreadable document is not cached: nothing was produced to cache, and the
  // next call should ask storage again in case it has been repaired.
  if (result.status === "unreadable") throw result.error;

  cache = { text, data: result.data };
  return result.data;
}

function save(data: AppData): void {
  const text = doc.serialize(data);

  try {
    storage().setItem(STORAGE_KEY, text);
  } catch (cause) {
    // The write did not land. `localStorage` replaces a key atomically, so the
    // previous document is still there untouched — but the screen must say so
    // instead of showing the value as if it had been saved (AC-7.12).
    console.error("[store] could not write to localStorage:", cause);
    // The cache is left alone deliberately: it still matches what is stored.
    if (isQuotaExceeded(cause)) throw quotaError();
    throw unavailableError();
  }

  cache = { text, data };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The habits, in display order.
 *
 * `includeArchived` additionally returns the deleted ones (active first). The
 * heatmap asks for them: their entries are kept on purpose, and without their
 * names that history would be undrawable.
 */
export function getHabits(includeArchived: boolean = false): Habit[] {
  return doc.listHabits(load(), includeArchived);
}

/**
 * Records within an inclusive date range. Both bounds are `YYYY-MM-DD` strings
 * decided by the browser — nothing here asks what day it is.
 */
export function getEntries(from: string, to: string): Entry[] {
  return doc.listEntries(load(), from, to);
}

/**
 * Streaks and the 30 day achievement rate, as of `today` (`YYYY-MM-DD`).
 *
 * The day is a required argument for the same reason it always was: an
 * unfinished today is treated differently from a missed one, so which day it is
 * has to come from the browser that knows (docs/design.md §1).
 */
export function getStats(today: string): HabitStats[] {
  return doc.computeAllStats(load(), today);
}

// ---------------------------------------------------------------------------
// Writes
//
// Each one is load → apply → save. The document is replaced whole, which is what
// `localStorage` offers anyway: there is no partial write to leave behind.
// ---------------------------------------------------------------------------

/** The wall clock, in the one place a stored timestamp is created. */
function now(): string {
  return new Date().toISOString();
}

export function createHabit(input: CreateHabitInput): Habit {
  const { data, habit } = doc.createHabit(load(), input, now());
  save(data);
  return habit;
}

export function updateHabit(id: number, patch: UpdateHabitInput): Habit {
  const { data, habit } = doc.updateHabit(load(), id, patch);
  save(data);
  return habit;
}

/** Archives the habit. Its entries are kept — this is a logical delete. */
export function deleteHabit(id: number): void {
  const { data } = doc.archiveHabit(load(), id, now());
  save(data);
}

/** Undo of the above: the habit is listed again, with the records it kept. */
export function restoreHabit(id: number): Habit {
  const { data, habit } = doc.restoreHabit(load(), id);
  save(data);
  return habit;
}

/** Records one day's value for one habit, replacing whatever was there. */
export function putEntry(habitId: number, date: string, value: number): Entry {
  const { data, entry } = doc.putEntry(load(), habitId, date, value);
  save(data);
  return entry;
}
