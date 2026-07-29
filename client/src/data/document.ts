import { isISODate } from "../../../shared/domain.ts";
import { computeStats } from "../../../shared/stats.ts";
import type { HabitDatedValue, StatsHabit } from "../../../shared/stats.ts";
import type {
  CreateHabitInput,
  Entry,
  Habit,
  HabitKind,
  HabitStats,
  UpdateHabitInput,
} from "../../../shared/types.ts";
import type { DataError } from "../errors.ts";
import { corruptError, notFoundError, validationError } from "../errors.ts";

/**
 * The saved document, and every operation on it — as pure functions.
 *
 * This file knows nothing about `localStorage`. It turns a string into a
 * document, a document into a string, and a document plus an intent into a new
 * document. `store.ts` is the twenty lines that actually touch the browser.
 *
 * The split is deliberate: it is what lets `node:test` cover serialisation,
 * version handling and all of the CRUD rules directly (AC-7.5 / AC-7.6), instead
 * of only through a browser.
 *
 * Nothing here reads a clock either. Timestamps arrive as arguments, the same way
 * `today` always has (docs/design.md §1).
 */

/**
 * The `localStorage` key. The version is *not* in the key on purpose: a v2 that
 * changed the key would leave v1 data stranded under a name nothing reads, which
 * is data loss dressed up as a fresh start. The version lives in the document,
 * where a migration can find it.
 */
export const STORAGE_KEY = "habit-tracker";

/** Bumped only when the stored shape changes in a way a reader must know about. */
export const SCHEMA_VERSION = 1;

/**
 * Records, indexed `habit id → YYYY-MM-DD → value`.
 *
 * Not an array of `{habit_id, date, value}` rows, and the reason is measured:
 * ten habits over five years is 18,250 records, which as rows is ~1.4 MB of JSON
 * — and `localStorage` is a ~5 MB budget counted in UTF-16 code units, so that
 * is nearer 2.8 MB of the quota than it looks. Nesting drops the repeated
 * `"habit_id"` and `"date"` keys and lands around 0.3 MB (AC-7.11).
 *
 * The keys are habit ids rendered as decimal strings, because JSON object keys
 * are strings and there is nothing to be gained by pretending otherwise.
 */
export type EntryIndex = Record<string, Record<string, number>>;

/** Everything the app owns, in the shape it is stored. */
export type AppData = {
  version: number;
  /** The next habit id to hand out. Monotonic; never reused, even after delete. */
  next_habit_id: number;
  habits: Habit[];
  entries: EntryIndex;
};

/** A document with nothing in it. A fresh browser starts here (AC-7.10). */
export function emptyData(): AppData {
  return { version: SCHEMA_VERSION, next_habit_id: 1, habits: [], entries: {} };
}

// ---------------------------------------------------------------------------
// Serialisation and version handling
// ---------------------------------------------------------------------------

export function serialize(data: AppData): string {
  return JSON.stringify(data);
}

/**
 * What `parse` made of the stored string.
 *
 * `unreadable` is the case AC-7.6 is about. It carries no data, and the caller's
 * contract is that it must **not write** while in this state: overwriting a
 * document we failed to understand is the "silently destroys existing data"
 * failure, whatever the reason we failed for. Refusing to write keeps the bytes
 * on disk for a later version — or for a human with devtools — to recover.
 */
export type ParseResult =
  | { status: "empty"; data: AppData }
  | { status: "ok"; data: AppData }
  | { status: "unreadable"; error: DataError };

const UNKNOWN_VERSION_MESSAGE =
  "保存されたデータが新しい形式です。アプリを最新版に更新してください（データは変更していません）";
const CORRUPT_MESSAGE =
  "保存されたデータを読み取れませんでした。データを上書きしないよう、保存を停止しています";

function unreadable(message: string): ParseResult {
  return { status: "unreadable", error: corruptError(message) };
}

/**
 * Reads the stored string.
 *
 * Absent and empty both mean "nothing saved yet" — `setItem(key, "")` is a thing
 * that happens — and neither is an error: there is no data to protect, so the app
 * starts empty and the first write creates the document.
 */
export function parse(text: string | null | undefined): ParseResult {
  if (text === null || text === undefined || text.trim() === "") {
    return { status: "empty", data: emptyData() };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unreadable(CORRUPT_MESSAGE);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unreadable(CORRUPT_MESSAGE);

  const fields = raw as Record<string, unknown>;
  const version = fields["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return unreadable(CORRUPT_MESSAGE);
  }

  // A document from a *newer* build. Nothing here can know what it means, and
  // guessing would rewrite it in an older shape — so it is left exactly as it is
  // and the user is told to update (rather than shown an empty app).
  if (version > SCHEMA_VERSION) return unreadable(UNKNOWN_VERSION_MESSAGE);

  // Older versions would be migrated here. v1 is the first, so there is nothing
  // to migrate yet; the branch exists so that adding v2 has an obvious home.
  const data = readV1(fields);
  if (data === null) return unreadable(CORRUPT_MESSAGE);

  return { status: "ok", data };
}

function readV1(fields: Record<string, unknown>): AppData | null {
  const rawHabits = fields["habits"];
  const rawEntries = fields["entries"];

  if (!Array.isArray(rawHabits)) return null;
  if (typeof rawEntries !== "object" || rawEntries === null || Array.isArray(rawEntries)) return null;

  const habits: Habit[] = [];
  for (const candidate of rawHabits) {
    const habit = readHabit(candidate);
    // A single unreadable habit fails the whole document rather than being
    // dropped: skipping it would be exactly the silent destruction AC-7.6
    // forbids, only spread over one row instead of all of them.
    if (habit === null) return null;
    habits.push(habit);
  }

  const entries: EntryIndex = {};
  for (const [habitKey, days] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (!/^\d+$/.test(habitKey)) return null;
    if (typeof days !== "object" || days === null || Array.isArray(days)) return null;

    const byDate: Record<string, number> = {};
    for (const [date, value] of Object.entries(days as Record<string, unknown>)) {
      if (!isISODate(date)) return null;
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      byDate[date] = value;
    }
    entries[habitKey] = byDate;
  }

  // A missing counter is repaired from the ids present rather than failing: it is
  // derivable, and the alternative is bricking a document whose habits are all
  // perfectly readable. It is never allowed to go *backwards*, which is the only
  // property that matters — a reused id would attach old entries to a new habit.
  const storedNext = fields["next_habit_id"];
  const maxId = habits.reduce((max, habit) => Math.max(max, habit.id), 0);
  const next =
    typeof storedNext === "number" && Number.isSafeInteger(storedNext) && storedNext > maxId
      ? storedNext
      : maxId + 1;

  return { version: SCHEMA_VERSION, next_habit_id: next, habits, entries };
}

/**
 * One habit, validated and normalised, or `null` when the value cannot be one.
 *
 * Exported so that `backup.ts` reads an imported habit through exactly the same
 * rules as a stored one. A second, slightly different validator for the import
 * path would be a way to get a habit into storage that the store itself would
 * later declare unreadable.
 */
export function readHabit(candidate: unknown): Habit | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const fields = candidate as Record<string, unknown>;

  const id = fields["id"];
  const name = fields["name"];
  const kind = fields["kind"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof name !== "string") return null;
  if (kind !== "boolean" && kind !== "numeric") return null;

  const target = fields["target"];
  if (target !== null && target !== undefined && (typeof target !== "number" || !Number.isFinite(target))) {
    return null;
  }

  const unit = fields["unit"];
  if (unit !== null && unit !== undefined && typeof unit !== "string") return null;

  const archivedAt = fields["archived_at"];
  if (archivedAt !== null && archivedAt !== undefined && typeof archivedAt !== "string") return null;

  const color = fields["color"];
  const sortOrder = fields["sort_order"];
  const createdAt = fields["created_at"];

  return {
    id,
    name,
    kind: kind as HabitKind,
    target: typeof target === "number" ? target : null,
    unit: typeof unit === "string" ? unit : null,
    color: typeof color === "string" && color !== "" ? color : DEFAULT_COLOR,
    sort_order: typeof sortOrder === "number" && Number.isFinite(sortOrder) ? sortOrder : 0,
    archived_at: typeof archivedAt === "string" ? archivedAt : null,
    created_at: typeof createdAt === "string" ? createdAt : "",
  };
}

// ---------------------------------------------------------------------------
// Validation
//
// Kept from the server routes it replaces, messages and all. There is no
// untrusted client any more, but these are the sentences the form shows when a
// value is wrong, and they are the last thing standing between a typo and a
// habit that `isAchieved()` can no longer answer for.
// ---------------------------------------------------------------------------

/** Palette keys the heatmap understands. */
export const HABIT_COLORS = ["blue", "green", "purple", "orange", "pink"] as const;

const DEFAULT_COLOR = HABIT_COLORS[0];

const MAX_NAME_LENGTH = 60;
const MAX_UNIT_LENGTH = 12;
/** Guards against a target that would render as `1e+21` and break every layout. */
const MAX_TARGET = 1_000_000;
/** Same ceiling for a recorded value. */
const MAX_VALUE = 1_000_000;

function parseName(raw: unknown): string {
  if (typeof raw !== "string") throw validationError("習慣名を入力してください");
  const name = raw.trim();
  if (name === "") throw validationError("習慣名を入力してください");
  if (name.length > MAX_NAME_LENGTH) {
    throw validationError(`習慣名は ${MAX_NAME_LENGTH} 文字以内で入力してください`);
  }
  return name;
}

/**
 * A target that may also be absent. `null` is a value, not a missing field: it
 * means "no goal", and it is the only way to take a goal back off a habit.
 */
function parseOptionalTarget(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw validationError("目標値を数値で入力してください");
  if (raw <= 0) throw validationError("目標値は 0 より大きい値にしてください");
  if (raw > MAX_TARGET) throw validationError(`目標値は ${MAX_TARGET} 以下にしてください`);
  return raw;
}

function parseUnit(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw validationError("単位は文字列で入力してください");
  const unit = raw.trim();
  if (unit === "") return null;
  if (unit.length > MAX_UNIT_LENGTH) {
    throw validationError(`単位は ${MAX_UNIT_LENGTH} 文字以内で入力してください`);
  }
  return unit;
}

function parseColor(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string" || !(HABIT_COLORS as readonly string[]).includes(raw)) {
    throw validationError(`色は ${HABIT_COLORS.join(" / ")} のいずれかを指定してください`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Active habits in display order; archived ones after them when asked for. */
export function listHabits(data: AppData, includeArchived: boolean = false): Habit[] {
  const byOrder = (a: Habit, b: Habit): number => a.sort_order - b.sort_order || a.id - b.id;

  const active = data.habits.filter((habit) => habit.archived_at === null).sort(byOrder);
  if (!includeArchived) return active;

  const archived = data.habits.filter((habit) => habit.archived_at !== null).sort(byOrder);
  return [...active, ...archived];
}

/** One habit, archived or not. Null when there is no such id. */
export function findHabit(data: AppData, id: number): Habit | null {
  return data.habits.find((habit) => habit.id === id) ?? null;
}

/**
 * Records within an inclusive date range, of every habit including archived
 * ones — they are exactly the history logical deletion exists to preserve.
 *
 * Ordered by date then habit id, which is the order the SQLite query returned
 * and the order the heatmap and the today panel were written against.
 */
export function listEntries(data: AppData, from?: string, to?: string): Entry[] {
  const entries: Entry[] = [];

  for (const [habitKey, days] of Object.entries(data.entries)) {
    const habitId = Number(habitKey);
    for (const [date, value] of Object.entries(days)) {
      if (from !== undefined && from !== "" && date < from) continue;
      if (to !== undefined && to !== "" && date > to) continue;
      entries.push({ habit_id: habitId, date, value });
    }
  }

  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.habit_id - b.habit_id));
  return entries;
}

/**
 * Streaks and rates for the active habits, as of `today`.
 *
 * The maths is `shared/stats.ts` and nothing else — the same pure functions the
 * server called, moved rather than rewritten (AC-7.13). All this does is hand it
 * rows.
 */
export function computeAllStats(data: AppData, today: string): HabitStats[] {
  if (!isISODate(today)) throw validationError("today は YYYY-MM-DD 形式で指定してください");

  const habits = listHabits(data, false);
  if (habits.length === 0) return [];

  const statsHabits: StatsHabit[] = habits.map((habit) => ({
    id: habit.id,
    kind: habit.kind,
    target: habit.target,
  }));

  // Every record up to today, not just the window: the longest streak is a
  // question about the whole history.
  const records: HabitDatedValue[] = [];
  for (const habit of habits) {
    const days = data.entries[String(habit.id)];
    if (days === undefined) continue;
    for (const [date, value] of Object.entries(days)) {
      if (date <= today) records.push({ habit_id: habit.id, date, value });
    }
  }

  return computeStats(statsHabits, records, today);
}

// ---------------------------------------------------------------------------
// Writes — each returns a new document; none mutates the one it was given
// ---------------------------------------------------------------------------

export type CreateResult = { data: AppData; habit: Habit };

/**
 * Adds a habit. `now` is the caller's timestamp — the browser's clock, since
 * there is no other one left. Nothing in the app compares `created_at` against a
 * calendar day (AC-4.9 is explicit that the rate window is not clamped by it), so
 * a pinned or skewed clock cannot move a number on screen.
 */
export function createHabit(data: AppData, input: CreateHabitInput, now: string): CreateResult {
  const name = parseName(input.name);

  const kind = input.kind;
  if (kind !== "boolean" && kind !== "numeric") {
    throw validationError("種類は boolean か numeric を指定してください");
  }

  // Rotating the default keeps a fresh list from being five identical colours in
  // the heatmap; an explicit `color` always wins.
  const fallbackColor = HABIT_COLORS[data.habits.length % HABIT_COLORS.length] ?? DEFAULT_COLOR;
  const color = parseColor(input.color, fallbackColor);

  // A check-style habit has no target and no unit, whatever was passed.
  const target = kind === "boolean" ? null : parseOptionalTarget(input.target);
  const unit = kind === "boolean" ? null : parseUnit(input.unit);

  const sortOrder = data.habits.reduce((max, habit) => Math.max(max, habit.sort_order), -1) + 1;

  const habit: Habit = {
    id: data.next_habit_id,
    name,
    kind,
    target,
    unit,
    color,
    sort_order: sortOrder,
    archived_at: null,
    created_at: now,
  };

  return {
    data: { ...data, next_habit_id: data.next_habit_id + 1, habits: [...data.habits, habit] },
    habit,
  };
}

const NOT_FOUND = "習慣が見つかりません";

/** Replaces one habit in the list, keeping its position. */
function withHabit(data: AppData, updated: Habit): AppData {
  return { ...data, habits: data.habits.map((habit) => (habit.id === updated.id ? updated : habit)) };
}

/**
 * Applies a patch. An archived habit answers like an id that does not exist: it
 * is deleted as far as its owner is concerned.
 */
export function updateHabit(data: AppData, id: number, patch: UpdateHabitInput): CreateResult {
  const current = findHabit(data, id);
  if (current === null || current.archived_at !== null) throw notFoundError(NOT_FOUND);

  const name = patch.name === undefined ? current.name : parseName(patch.name);
  const color = parseColor(patch.color, current.color);

  // `kind` is immutable, so a boolean habit can never grow a target.
  const target =
    current.kind === "boolean" ? null : patch.target === undefined ? current.target : parseOptionalTarget(patch.target);
  const unit =
    current.kind === "boolean" ? null : patch.unit === undefined ? current.unit : parseUnit(patch.unit);

  const habit: Habit = { ...current, name, target, unit, color };
  return { data: withHabit(data, habit), habit };
}

/**
 * Logical delete (AC-7.7): stamp `archived_at` and leave every entry alone. The
 * records have to survive — Phase 8's export is required to contain them.
 *
 * Deleting twice is a "not found" rather than a silent rewrite of the timestamp.
 */
export function archiveHabit(data: AppData, id: number, now: string): CreateResult {
  const current = findHabit(data, id);
  if (current === null || current.archived_at !== null) throw notFoundError(NOT_FOUND);

  const habit: Habit = { ...current, archived_at: now };
  return { data: withHabit(data, habit), habit };
}

/** Undo of the above: the habit is listed again, with the records it kept. */
export function restoreHabit(data: AppData, id: number): CreateResult {
  const current = findHabit(data, id);
  if (current === null || current.archived_at === null) throw notFoundError(NOT_FOUND);

  const habit: Habit = { ...current, archived_at: null };
  return { data: withHabit(data, habit), habit };
}

export type PutEntryResult = { data: AppData; entry: Entry };

/**
 * Records one day's value for one habit, replacing whatever was there.
 *
 * `value: 0` is stored, not deleted — an explicit "did not do it today" is
 * information, and the heatmap paints it differently from a day with no record
 * at all (AC-5.2).
 */
export function putEntry(data: AppData, habitId: number, date: string, value: number): PutEntryResult {
  if (!isISODate(date)) throw validationError("日付は YYYY-MM-DD 形式で指定してください");
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw validationError("value を数値で指定してください");
  }
  if (value < 0 || value > MAX_VALUE) {
    throw validationError(`value は 0 以上 ${MAX_VALUE} 以下で指定してください`);
  }

  const habit = findHabit(data, habitId);
  if (habit === null || habit.archived_at !== null) throw notFoundError(NOT_FOUND);

  const key = String(habitId);
  const days = { ...(data.entries[key] ?? {}), [date]: value };

  return {
    data: { ...data, entries: { ...data.entries, [key]: days } },
    entry: { habit_id: habitId, date, value },
  };
}
