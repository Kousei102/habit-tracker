import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { isISODate } from "../../../shared/domain.ts";
import type { ErrorResponse, StatsResponse } from "../../../shared/types.ts";
import type { AuthEnv } from "../auth.ts";
import { requireAuth } from "../auth.ts";
import type { HabitDatedValue } from "../stats.ts";
import { computeStats } from "../stats.ts";
import { listHabits } from "./habits.ts";

/**
 * `GET /api/stats?today=YYYY-MM-DD`.
 *
 * The day comes from the client and is mandatory: guessing it with `new Date()`
 * here would make every streak depend on the server's time zone, which is the
 * one thing the design rules out. A missing or malformed `today` is a 400 rather
 * than a silent fallback — a wrong day is worse than a visible error.
 *
 * The maths itself lives in `../stats.ts` as pure functions (docs/design.md:
 * statistics are computed in JS, not SQL, so they can be unit tested). This file
 * only reads rows and hands them over.
 */

type EntryRow = {
  habit_id: number;
  date: string;
  value: number;
};

export function createStatsRoutes(db: DatabaseSync): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  routes.use("*", requireAuth(db));

  routes.get("/", (c) => {
    const userId = c.get("user").id;

    const today = c.req.query("today");
    if (today === undefined || today === "") {
      const body: ErrorResponse = { error: "today を YYYY-MM-DD 形式で指定してください" };
      return c.json(body, 400);
    }
    if (!isISODate(today)) {
      const body: ErrorResponse = { error: "today は YYYY-MM-DD 形式で指定してください" };
      return c.json(body, 400);
    }

    // Only active habits get a row: an archived habit is gone from the user's
    // point of view, even though its entries are kept.
    const habits = listHabits(db, userId);
    if (habits.length === 0) {
      const empty: StatsResponse = { today, stats: [] };
      return c.json(empty);
    }

    // Every record up to today, not just the last 30 days: the longest streak is
    // a question about the whole history. A personal tracker's `entries` table is
    // a few thousand rows a year, so reading it whole stays cheap and keeps the
    // maths in one testable place.
    const rows = db
      .prepare(
        `SELECT e.habit_id AS habit_id, e.date AS date, e.value AS value
           FROM entries e
           JOIN habits h ON h.id = e.habit_id
          WHERE h.user_id = ? AND h.archived_at IS NULL AND e.date <= ?
          ORDER BY e.date`,
      )
      .all(userId, today) as unknown as EntryRow[];

    const records: HabitDatedValue[] = rows.map((row) => ({
      habit_id: row.habit_id,
      date: row.date,
      value: row.value,
    }));

    const body: StatsResponse = {
      today,
      stats: computeStats(habits, records, today),
    };
    return c.json(body);
  });

  return routes;
}
