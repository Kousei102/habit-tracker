import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { isISODate } from "../../../shared/domain.ts";
import type { Entry, ErrorResponse } from "../../../shared/types.ts";
import type { AuthEnv } from "../auth.ts";
import { requireAuth } from "../auth.ts";
import { findHabit } from "./habits.ts";

/**
 * Daily records.
 *
 * The date is part of the URL and never computed here: "today" is whatever the
 * client says it is (docs/design.md). A `new Date()` in this file would make the
 * result depend on the server's time zone, which is the one thing this design
 * set out to avoid.
 */

const MAX_VALUE = 1_000_000;

type EntryRow = {
  habit_id: number;
  date: string;
  value: number;
  updated_at: string;
};

const NOT_FOUND: ErrorResponse = { error: "習慣が見つかりません" };
const MALFORMED: ErrorResponse = { error: "リクエストの形式が不正です" };

/** Path ids are strings; anything that is not a positive integer cannot exist. */
function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function createEntriesRoutes(db: DatabaseSync): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  routes.use("*", requireAuth(db));

  /**
   * `GET /api/entries?from=&to=` — the records of this user's habits within an
   * inclusive date range. Both bounds are optional; omitting them returns
   * everything, which is what a fresh client needs anyway.
   *
   * Entries of archived habits are included: they are exactly the history that
   * logical deletion exists to preserve.
   */
  routes.get("/", (c) => {
    const userId = c.get("user").id;
    const from = c.req.query("from");
    const to = c.req.query("to");

    for (const [name, value] of [
      ["from", from],
      ["to", to],
    ] as const) {
      if (value !== undefined && value !== "" && !isISODate(value)) {
        const body: ErrorResponse = { error: `${name} は YYYY-MM-DD 形式で指定してください` };
        return c.json(body, 400);
      }
    }

    const conditions = ["h.user_id = ?"];
    const params: (number | string)[] = [userId];

    if (from !== undefined && from !== "") {
      conditions.push("e.date >= ?");
      params.push(from);
    }
    if (to !== undefined && to !== "") {
      conditions.push("e.date <= ?");
      params.push(to);
    }

    const rows = db
      .prepare(
        `SELECT e.habit_id AS habit_id, e.date AS date, e.value AS value, e.updated_at AS updated_at
           FROM entries e
           JOIN habits h ON h.id = e.habit_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY e.date, e.habit_id`,
      )
      .all(...params) as unknown as EntryRow[];

    const entries: Entry[] = rows.map((row) => ({
      habit_id: row.habit_id,
      date: row.date,
      value: row.value,
      updated_at: row.updated_at,
    }));

    return c.json(entries);
  });

  /**
   * `PUT /api/entries/:habitId/:date` — upsert one day's value.
   *
   * AC-3.7: an id that does not exist and an id belonging to somebody else both
   * answer 404, so the endpoint cannot be used to probe for existence.
   * AC-3.8: `(habit_id, date)` is the primary key and the write is an
   * `ON CONFLICT DO UPDATE`, so calling this twice for one day overwrites rather
   * than duplicating.
   */
  routes.put("/:habitId/:date", async (c) => {
    const userId = c.get("user").id;

    const habitId = parseId(c.req.param("habitId"));
    if (habitId === null) return c.json(NOT_FOUND, 404);

    const date = c.req.param("date");
    if (!isISODate(date)) {
      const body: ErrorResponse = { error: "日付は YYYY-MM-DD 形式で指定してください" };
      return c.json(body, 400);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(MALFORMED, 400);
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return c.json(MALFORMED, 400);
    }

    const value = (raw as Record<string, unknown>)["value"];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      const body: ErrorResponse = { error: "value を数値で指定してください" };
      return c.json(body, 400);
    }
    if (value < 0 || value > MAX_VALUE) {
      const body: ErrorResponse = { error: `value は 0 以上 ${MAX_VALUE} 以下で指定してください` };
      return c.json(body, 400);
    }

    // The user scope is what turns "somebody else's habit" into "no such habit".
    // An archived habit answers the same way: it is deleted as far as its owner
    // is concerned, even though its past entries are kept.
    const habit = findHabit(db, userId, habitId);
    if (habit === null || habit.archived_at !== null) return c.json(NOT_FOUND, 404);

    // `value: 0` is stored, not deleted — an explicit "did not do it today" is
    // information, and keeping the row is what makes a second PUT an overwrite.
    const updatedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO entries (habit_id, date, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (habit_id, date) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(habitId, date, value, updatedAt);

    const entry: Entry = { habit_id: habitId, date, value, updated_at: updatedAt };
    return c.json(entry);
  });

  return routes;
}
