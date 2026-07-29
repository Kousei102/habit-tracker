import { isISODate } from "../../../shared/domain.ts";
import type { Habit } from "../../../shared/types.ts";
import type { AppData, EntryIndex } from "./document.ts";
import { SCHEMA_VERSION, readHabit } from "./document.ts";

/**
 * Taking the data out of the browser, and putting it back.
 *
 * This is the whole reason Phase 8 exists. The records live in one localStorage
 * key on one phone; WebKit clears that key after seven days of not opening the
 * site, and only promises *not to expect* to clear it for a home screen web app.
 * "We do not expect" is not a backup. A file the user holds is.
 *
 * Everything here is a pure function of its arguments — no storage, no clock, no
 * DOM — so `node:test` can throw every broken input it can think of at
 * `parseImport` without a browser. That matters more here than anywhere else in
 * the app: AC-8.8 says a bad file must not damage what is already saved, and the
 * only way to guarantee that is for the entire decision to happen before a
 * single byte is written.
 */

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

/**
 * The marker that says "this JSON is one of ours".
 *
 * Without it, "this is not the app's file" (AC-8.8) can only be guessed at from
 * the shape, and a JSON file that happens to have a `habits` array would be
 * imported as if it were a backup.
 */
export const EXPORT_FORMAT = "habit-tracker-export";

/**
 * The version of the *file*, which is not the version of the stored document.
 *
 * They are separate on purpose. The storage format exists to fit in a 5 MB quota
 * and will change whenever that pressure changes; the file format exists to be
 * read years later, possibly by something that is not this app. Tying them
 * together would mean every storage tweak invalidating every backup a user
 * holds.
 */
export const EXPORT_FORMAT_VERSION = 1;

/**
 * A backup file.
 *
 * `entries` is a flat array of records rather than the nested
 * `habit → date → value` index the browser stores. The nesting exists to save
 * quota, and a file on disk has no quota; what a file needs is to be legible on
 * its own terms, by a person or a script, long after the app that wrote it. Each
 * row here carries its own field names and needs no knowledge of the format to
 * understand.
 */
export type ExportFile = {
  format: typeof EXPORT_FORMAT;
  format_version: number;
  /** The storage schema the data came from. Informational; kept for forensics. */
  app_schema_version: number;
  /** When the export was taken, as the exporting browser saw it. */
  exported_at: string;
  next_habit_id: number;
  /** Every habit, **including deleted ones** (AC-8.5). */
  habits: Habit[];
  entries: Array<{ habit_id: number; date: string; value: number }>;
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The whole document as a file.
 *
 * Deleted habits and their records are included, and this is not incidental: the
 * delete is logical precisely so the history survives (docs/design.md §4), and an
 * export that dropped them would quietly undo that on every backup/restore cycle.
 */
export function buildExport(data: AppData, exportedAt: string): ExportFile {
  const entries: ExportFile["entries"] = [];

  for (const [habitKey, days] of Object.entries(data.entries)) {
    const habitId = Number(habitKey);
    for (const [date, value] of Object.entries(days)) {
      entries.push({ habit_id: habitId, date, value });
    }
  }

  // Stable order, so two exports of the same data are the same file — which is
  // what lets a user diff two backups, or notice that nothing changed.
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.habit_id - b.habit_id));

  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    app_schema_version: data.version,
    exported_at: exportedAt,
    next_habit_id: data.next_habit_id,
    habits: data.habits.map((habit) => ({ ...habit })),
    entries,
  };
}

/**
 * The bytes to download. Indented, and that is a decision rather than a default:
 * the file's job is to still be readable when the app that wrote it is gone, and
 * one record per line is the difference between "recoverable by hand" and "a
 * megabyte on one line". Five years of records costs about 1.6 MB this way
 * instead of 0.9 MB, which is nothing for a file and everything for a person.
 */
export function serializeExport(file: ExportFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * `habit-tracker-2026-07-29.json`.
 *
 * The date is in the name so that a phone's Files app sorts backups into
 * generations instead of asking "replace habit-tracker.json?" every time. It is
 * the browser's `today`, passed in — this app never asks a clock what day it is
 * outside `useToday` (docs/design.md §1).
 */
export function exportFilename(today: string): string {
  const day = isISODate(today) ? today : "unknown";
  return `habit-tracker-${day}.json`;
}

// ---------------------------------------------------------------------------
// Summary — what the user is told before anything is replaced (AC-8.7)
// ---------------------------------------------------------------------------

export type BackupSummary = {
  habitCount: number;
  /** How many of those are deleted habits, kept for their history. */
  archivedCount: number;
  entryCount: number;
  /** Earliest and latest recorded day, or null when there are no records. */
  firstDate: string | null;
  lastDate: string | null;
};

export function summarize(file: ExportFile): BackupSummary {
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  for (const entry of file.entries) {
    if (firstDate === null || entry.date < firstDate) firstDate = entry.date;
    if (lastDate === null || entry.date > lastDate) lastDate = entry.date;
  }

  return {
    habitCount: file.habits.length,
    archivedCount: file.habits.filter((habit) => habit.archived_at !== null).length,
    entryCount: file.entries.length,
    firstDate,
    lastDate,
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * What `parseImport` made of a file.
 *
 * Either a complete document ready to be written, or a sentence explaining why
 * nothing will be. There is no partial success: a file is understood in full or
 * it is refused, because the alternative is replacing a working document with
 * half of a broken one (AC-8.8).
 */
export type ImportResult =
  | { status: "ok"; data: AppData; summary: BackupSummary }
  | { status: "error"; message: string };

function fail(message: string): ImportResult {
  return { status: "error", message };
}

const NOT_OUR_FILE =
  "このファイルは習慣トラッカーのバックアップではありません。エクスポートした JSON ファイルを選んでください";
const BROKEN_FILE = "ファイルの内容を読み取れませんでした。壊れている可能性があります";
const NEWER_FILE = "このバックアップは新しい形式です。アプリを最新版に更新してから読み込んでください";

/**
 * Reads a backup file.
 *
 * **Nothing is written from here.** The caller only gets an `AppData` once every
 * field has been checked, which is what makes "a broken file leaves the existing
 * data alone" a property of the code rather than a promise.
 *
 * Strict about structure, deliberately relaxed about two things:
 *
 *  - **Unknown fields are ignored.** A file from a later version that only added
 *    fields still restores, which is the whole point of having a format version.
 *  - **Records whose habit is missing are kept.** The stored document already
 *    tolerates them, and dropping records is the one thing a restore must never
 *    do. They are invisible until a habit with that id exists again, but they
 *    are not gone.
 */
export function parseImport(text: string): ImportResult {
  if (typeof text !== "string" || text.trim() === "") return fail("ファイルが空です");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(BROKEN_FILE);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(NOT_OUR_FILE);

  const fields = raw as Record<string, unknown>;
  if (fields["format"] !== EXPORT_FORMAT) return fail(NOT_OUR_FILE);

  const formatVersion = fields["format_version"];
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    return fail(NOT_OUR_FILE);
  }
  // A file from a newer build is refused rather than guessed at — the same rule
  // the stored document follows (AC-7.6).
  if (formatVersion > EXPORT_FORMAT_VERSION) return fail(NEWER_FILE);

  const rawHabits = fields["habits"];
  if (!Array.isArray(rawHabits)) return fail(BROKEN_FILE);

  const habits: Habit[] = [];
  const seenIds = new Set<number>();
  for (const candidate of rawHabits) {
    // The same reader the stored document uses, so a habit that this app can
    // hold is exactly a habit it can import.
    const habit = readHabit(candidate);
    if (habit === null) return fail(BROKEN_FILE);
    // Two habits sharing an id would share one bucket of records; there is no
    // reading of that file which is not already data loss.
    if (seenIds.has(habit.id)) return fail("同じ ID の習慣が重複しています。ファイルが壊れています");
    seenIds.add(habit.id);
    habits.push(habit);
  }

  const rawEntries = fields["entries"];
  if (!Array.isArray(rawEntries)) return fail(BROKEN_FILE);

  const entries: EntryIndex = {};
  let entryCount = 0;
  for (const candidate of rawEntries) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return fail(BROKEN_FILE);
    }
    const row = candidate as Record<string, unknown>;

    const habitId = row["habit_id"];
    const date = row["date"];
    const value = row["value"];

    if (typeof habitId !== "number" || !Number.isSafeInteger(habitId) || habitId <= 0) return fail(BROKEN_FILE);
    if (!isISODate(date)) return fail(BROKEN_FILE);
    if (typeof value !== "number" || !Number.isFinite(value)) return fail(BROKEN_FILE);

    const key = String(habitId);
    const days = entries[key] ?? {};
    // A duplicate `(habit, date)` is a map key written twice: the last one wins,
    // exactly as it would if the file had been an object in the first place.
    if (days[date] === undefined) entryCount += 1;
    days[date] = value;
    entries[key] = days;
  }

  const maxId = habits.reduce((max, habit) => Math.max(max, habit.id), 0);
  const storedNext = fields["next_habit_id"];
  // Never allowed to go backwards: a reused id would attach an old habit's
  // records to a new habit.
  const nextHabitId =
    typeof storedNext === "number" && Number.isSafeInteger(storedNext) && storedNext > maxId
      ? storedNext
      : maxId + 1;

  const data: AppData = {
    version: SCHEMA_VERSION,
    next_habit_id: nextHabitId,
    habits,
    entries,
  };

  const exportedAt = fields["exported_at"];
  const summary = summarize({
    format: EXPORT_FORMAT,
    format_version: formatVersion,
    app_schema_version: SCHEMA_VERSION,
    exported_at: typeof exportedAt === "string" ? exportedAt : "",
    next_habit_id: nextHabitId,
    habits,
    entries: flatten(entries),
  });

  // `summarize` counts the rows it is given; the de-duplicated count is the
  // truthful one to show before a replace.
  return { status: "ok", data, summary: { ...summary, entryCount } };
}

/** The nested index as flat rows. Shared by the summary and by `buildExport`. */
function flatten(entries: EntryIndex): ExportFile["entries"] {
  const rows: ExportFile["entries"] = [];
  for (const [habitKey, days] of Object.entries(entries)) {
    const habitId = Number(habitKey);
    for (const [date, value] of Object.entries(days)) rows.push({ habit_id: habitId, date, value });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Nagging, carefully
// ---------------------------------------------------------------------------

/** How stale a backup has to be before the screen mentions it. */
export const REMIND_AFTER_DAYS = 30;

/**
 * Whether to say anything about backups, and what.
 *
 * `null` means say nothing. An app that warns on every visit gets the warning
 * ignored, and then it protects nobody — so this stays quiet while there is
 * nothing to lose (no habits yet) and while the last export is recent. The date
 * itself is always on screen regardless (AC-8.9); this is only the nudge.
 */
export function exportReminder(
  lastExport: string | null,
  today: string,
  hasData: boolean,
): string | null {
  if (!hasData) return null;

  if (lastExport === null) {
    return "まだ一度もエクスポートしていません。この端末のブラウザから記録が消えると元に戻せません。";
  }

  if (!isISODate(lastExport) || !isISODate(today)) return null;

  const days = daysBetween(lastExport, today);
  if (days < REMIND_AFTER_DAYS) return null;

  return `最後のエクスポートから ${days} 日経っています。新しいバックアップを取っておくと安全です。`;
}

/** One day, in milliseconds. Exact in UTC, where no day is 23 or 25 hours long. */
const DAY_MS = 86_400_000;

/**
 * Whole days from `from` to `to`, never negative.
 *
 * Done in UTC, because a date string carries no time zone and doing the
 * subtraction in local time would return 0 or 2 across a DST boundary — the same
 * reasoning as `addDays` in shared/domain.ts. A clock that has gone backwards
 * (or a file restored from a device set to the future) yields 0 rather than a
 * negative reminder.
 */
export function daysBetween(from: string, to: string): number {
  if (!isISODate(from) || !isISODate(to) || to <= from) return 0;

  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number) as [number, number, number];
  const [toYear, toMonth, toDay] = to.split("-").map(Number) as [number, number, number];

  const start = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const end = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.round((end - start) / DAY_MS);
}
