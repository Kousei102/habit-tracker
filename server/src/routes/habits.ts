import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type {
  DeleteHabitResponse,
  ErrorResponse,
  Habit,
  HabitKind,
} from "../../../shared/types.ts";
import type { AuthEnv } from "../auth.ts";
import { requireAuth } from "../auth.ts";

/**
 * Habit CRUD.
 *
 * Two rules run through every handler:
 *
 *  - **Everything is scoped by `user_id`.** Single-user deployment or not, a
 *    query without that predicate is a bug waiting for the second user.
 *  - **A row this user cannot see is a 404, never a 403** (docs/design.md): 403
 *    would confirm that the id exists.
 *
 * Deletion is logical — `archived_at` is stamped and the entries stay — because
 * removing a habit should not punch a hole in last year's heatmap.
 */

/** Columns handed to the client. `user_id` is not one of them. */
const HABIT_COLUMNS = "id, name, kind, target, unit, color, sort_order, archived_at, created_at";

/** Palette keys the heatmap will understand. */
export const HABIT_COLORS = ["blue", "green", "purple", "orange", "pink"] as const;

const DEFAULT_COLOR = HABIT_COLORS[0];

const MAX_NAME_LENGTH = 60;
const MAX_UNIT_LENGTH = 12;
/** Guards against a target that would render as `1e+21` and break every layout. */
const MAX_TARGET = 1_000_000;

type HabitRow = {
  id: number;
  name: string;
  kind: string;
  target: number | null;
  unit: string | null;
  color: string;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
};

function toHabit(row: HabitRow): Habit {
  return {
    id: row.id,
    name: row.name,
    // The CHECK constraint on the column is what makes this cast safe.
    kind: row.kind as HabitKind,
    target: row.target,
    unit: row.unit,
    color: row.color,
    sort_order: row.sort_order,
    archived_at: row.archived_at,
    created_at: row.created_at,
  };
}

/** One habit of this user, archived or not. Null when it is not theirs to see. */
export function findHabit(db: DatabaseSync, userId: number, habitId: number): Habit | null {
  const row = db
    .prepare(`SELECT ${HABIT_COLUMNS} FROM habits WHERE id = ? AND user_id = ?`)
    .get(habitId, userId) as HabitRow | undefined;

  return row === undefined ? null : toHabit(row);
}

/** This user's active habits, in display order. Shared with the stats route. */
export function listHabits(db: DatabaseSync, userId: number): Habit[] {
  const rows = db
    .prepare(
      `SELECT ${HABIT_COLUMNS} FROM habits
        WHERE user_id = ? AND archived_at IS NULL
        ORDER BY sort_order, id`,
    )
    .all(userId) as unknown as HabitRow[];

  return rows.map(toHabit);
}

// ---------------------------------------------------------------------------
// Validation
//
// The shape of a habit is enforced here rather than trusted from the client:
// a `boolean` habit with a target, or a `numeric` habit without one, would make
// `isAchieved()` answer a question nobody asked.
// ---------------------------------------------------------------------------

type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

function invalid<T>(error: string): Valid<T> {
  return { ok: false, error };
}

function parseName(raw: unknown): Valid<string> {
  if (typeof raw !== "string") return invalid("習慣名を入力してください");
  const name = raw.trim();
  if (name === "") return invalid("習慣名を入力してください");
  if (name.length > MAX_NAME_LENGTH) return invalid(`習慣名は ${MAX_NAME_LENGTH} 文字以内で入力してください`);
  return { ok: true, value: name };
}

function parseTarget(raw: unknown): Valid<number> {
  // Numbers only: accepting "30" here would mean the client and the server
  // disagree about what a target is the first time someone sends "30分".
  if (typeof raw !== "number" || !Number.isFinite(raw)) return invalid("目標値を数値で入力してください");
  if (raw <= 0) return invalid("目標値は 0 より大きい値にしてください");
  if (raw > MAX_TARGET) return invalid(`目標値は ${MAX_TARGET} 以下にしてください`);
  return { ok: true, value: raw };
}

function parseUnit(raw: unknown): Valid<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return invalid("単位は文字列で入力してください");
  const unit = raw.trim();
  if (unit === "") return { ok: true, value: null };
  if (unit.length > MAX_UNIT_LENGTH) return invalid(`単位は ${MAX_UNIT_LENGTH} 文字以内で入力してください`);
  return { ok: true, value: unit };
}

function parseColor(raw: unknown, fallback: string): Valid<string> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: fallback };
  if (typeof raw !== "string" || !(HABIT_COLORS as readonly string[]).includes(raw)) {
    return invalid(`色は ${HABIT_COLORS.join(" / ")} のいずれかを指定してください`);
  }
  return { ok: true, value: raw };
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

type NewHabit = {
  name: string;
  kind: HabitKind;
  target: number | null;
  unit: string | null;
  color: string;
};

function parseCreate(body: unknown, fallbackColor: string): Valid<NewHabit> {
  const fields = asObject(body);
  if (fields === null) return invalid("リクエストの形式が不正です");

  const name = parseName(fields["name"]);
  if (!name.ok) return name;

  const kind = fields["kind"];
  if (kind !== "boolean" && kind !== "numeric") {
    return invalid("種類は boolean か numeric を指定してください");
  }

  const color = parseColor(fields["color"], fallbackColor);
  if (!color.ok) return color;

  // A check-style habit has no target and no unit — whatever the client sent.
  if (kind === "boolean") {
    return { ok: true, value: { name: name.value, kind, target: null, unit: null, color: color.value } };
  }

  const target = parseTarget(fields["target"]);
  if (!target.ok) return target;

  const unit = parseUnit(fields["unit"]);
  if (!unit.ok) return unit;

  return {
    ok: true,
    value: { name: name.value, kind, target: target.value, unit: unit.value, color: color.value },
  };
}

type HabitPatch = {
  name: string;
  target: number | null;
  unit: string | null;
  color: string;
};

/**
 * Merges a PATCH body onto the stored habit. `kind` is immutable: changing it
 * would leave existing entries measured in a unit that no longer exists.
 */
function parseUpdate(body: unknown, current: Habit): Valid<HabitPatch> {
  const fields = asObject(body);
  if (fields === null) return invalid("リクエストの形式が不正です");

  if (fields["kind"] !== undefined && fields["kind"] !== current.kind) {
    return invalid("習慣の種類は変更できません");
  }

  let name = current.name;
  if (fields["name"] !== undefined) {
    const parsed = parseName(fields["name"]);
    if (!parsed.ok) return parsed;
    name = parsed.value;
  }

  const color = parseColor(fields["color"], current.color);
  if (!color.ok) return color;

  if (current.kind === "boolean") {
    return { ok: true, value: { name, target: null, unit: null, color: color.value } };
  }

  let target = current.target;
  if (fields["target"] !== undefined) {
    const parsed = parseTarget(fields["target"]);
    if (!parsed.ok) return parsed;
    target = parsed.value;
  }

  let unit = current.unit;
  if (fields["unit"] !== undefined) {
    const parsed = parseUnit(fields["unit"]);
    if (!parsed.ok) return parsed;
    unit = parsed.value;
  }

  return { ok: true, value: { name, target, unit, color: color.value } };
}

/** Path ids are strings; anything that is not a positive integer cannot exist. */
function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const NOT_FOUND: ErrorResponse = { error: "習慣が見つかりません" };
const MALFORMED: ErrorResponse = { error: "リクエストの形式が不正です" };

export function createHabitsRoutes(db: DatabaseSync): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  // `*` covers the collection and every `/:id` below it, so no handler here can
  // end up outside the auth boundary by accident (AC-2.2).
  routes.use("*", requireAuth(db));

  /** The active habits of the signed-in user, in display order. */
  routes.get("/", (c) => {
    return c.json(listHabits(db, c.get("user").id));
  });

  routes.post("/", async (c) => {
    const userId = c.get("user").id;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(MALFORMED, 400);
    }

    // Rotating the default keeps a fresh list from being five identical colours
    // once the heatmap arrives; an explicit `color` always wins.
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM habits WHERE user_id = ?")
      .get(userId) as { n: number };
    const fallbackColor = HABIT_COLORS[existing.n % HABIT_COLORS.length] ?? DEFAULT_COLOR;

    const parsed = parseCreate(raw, fallbackColor);
    if (!parsed.ok) {
      const body: ErrorResponse = { error: parsed.error };
      return c.json(body, 400);
    }

    const next = db
      .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM habits WHERE user_id = ?")
      .get(userId) as { next: number };

    // created_at is a wall-clock timestamp, not a habit *date*: the rule the
    // design states is that day boundaries come from the client, and this value
    // never takes part in one.
    const result = db
      .prepare(
        `INSERT INTO habits (user_id, name, kind, target, unit, color, sort_order, archived_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        userId,
        parsed.value.name,
        parsed.value.kind,
        parsed.value.target,
        parsed.value.unit,
        parsed.value.color,
        next.next,
        new Date().toISOString(),
      );

    const created = findHabit(db, userId, Number(result.lastInsertRowid));
    if (created === null) return c.json(NOT_FOUND, 404);

    return c.json(created, 201);
  });

  routes.patch("/:id", async (c) => {
    const userId = c.get("user").id;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);

    // An archived habit is gone as far as its owner is concerned, so it answers
    // like any other id that does not exist.
    const current = findHabit(db, userId, id);
    if (current === null || current.archived_at !== null) return c.json(NOT_FOUND, 404);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(MALFORMED, 400);
    }

    const parsed = parseUpdate(raw, current);
    if (!parsed.ok) {
      const body: ErrorResponse = { error: parsed.error };
      return c.json(body, 400);
    }

    db.prepare(
      `UPDATE habits SET name = ?, target = ?, unit = ?, color = ?
        WHERE id = ? AND user_id = ?`,
    ).run(parsed.value.name, parsed.value.target, parsed.value.unit, parsed.value.color, id, userId);

    const updated = findHabit(db, userId, id);
    if (updated === null) return c.json(NOT_FOUND, 404);

    return c.json(updated);
  });

  /**
   * Logical delete (AC-3.6): stamp `archived_at` and leave `entries` untouched.
   * The `archived_at IS NULL` predicate makes a second delete a 404 rather than
   * a silent rewrite of the archive timestamp.
   */
  routes.delete("/:id", (c) => {
    const userId = c.get("user").id;
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);

    const result = db
      .prepare("UPDATE habits SET archived_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NULL")
      .run(new Date().toISOString(), id, userId);

    if (result.changes === 0) return c.json(NOT_FOUND, 404);

    const body: DeleteHabitResponse = { ok: true };
    return c.json(body);
  });

  return routes;
}
