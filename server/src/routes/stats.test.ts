import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Habit, StatsResponse } from "../../../shared/types.ts";
import { createApp } from "../app.ts";
import { SESSION_COOKIE, createSession, hashPassword } from "../auth.ts";
import { CLIENT_DIST } from "../config.ts";
import { openDb } from "../db.ts";

/**
 * `GET /api/stats` — the wiring around the pure functions in ../stats.ts.
 *
 * What matters here is what the route adds: the mandatory `today`, the user
 * scope, and the fact that archived habits drop out while their entries stay.
 * The streak maths itself is covered in ../stats.test.ts.
 */

const TODAY = "2026-03-15";

type Harness = {
  app: ReturnType<typeof createApp>;
  db: DatabaseSync;
  cookie: string;
  otherCookie: string;
};

function makeUser(db: DatabaseSync, username: string): number {
  const result = db
    .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
    .run(username, hashPassword(`${username}-password`), new Date().toISOString());
  return Number(result.lastInsertRowid);
}

function makeHarness(): Harness {
  const db = openDb(":memory:");
  const userId = makeUser(db, "owner");
  const otherUserId = makeUser(db, "intruder");

  return {
    app: createApp({ db, clientDist: CLIENT_DIST }),
    db,
    cookie: `${SESSION_COOKIE}=${createSession(db, userId).token}`,
    otherCookie: `${SESSION_COOKIE}=${createSession(db, otherUserId).token}`,
  };
}

function request(method: string, path: string, cookie?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers["cookie"] = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createHabit(h: Harness, cookie: string, body: unknown): Promise<Habit> {
  const response = await h.app.fetch(request("POST", "/api/habits", cookie, body));
  assert.equal(response.status, 201, `expected 201, got ${response.status}`);
  return (await response.json()) as Habit;
}

async function putEntry(h: Harness, cookie: string, habitId: number, date: string, value: number): Promise<Response> {
  return await h.app.fetch(request("PUT", `/api/entries/${habitId}/${date}`, cookie, { value }));
}

async function getStats(h: Harness, cookie: string, query: string): Promise<Response> {
  return await h.app.fetch(request("GET", `/api/stats${query}`, cookie));
}

describe("GET /api/stats", () => {
  it("requires a session", async () => {
    const h = makeHarness();

    const response = await h.app.fetch(request("GET", `/api/stats?today=${TODAY}`));

    assert.equal(response.status, 401);
    h.db.close();
  });

  it("rejects a missing today", async () => {
    const h = makeHarness();

    const response = await getStats(h, h.cookie, "");

    assert.equal(response.status, 400);
    h.db.close();
  });

  it("rejects a malformed today", async () => {
    const h = makeHarness();

    for (const today of ["2026-3-15", "15/03/2026", "2026-02-31", "yesterday", ""]) {
      const response = await getStats(h, h.cookie, `?today=${encodeURIComponent(today)}`);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(today)}`);
    }
    h.db.close();
  });

  it("answers with an empty list when the user has no habits", async () => {
    const h = makeHarness();

    const response = await getStats(h, h.cookie, `?today=${TODAY}`);

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()) as StatsResponse, { today: TODAY, stats: [] });
    h.db.close();
  });

  it("computes streaks from the recorded entries", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });

    // Yesterday and the two days before, but nothing for today yet.
    for (const date of ["2026-03-14", "2026-03-13", "2026-03-12"]) {
      const response = await putEntry(h, h.cookie, habit.id, date, 1);
      // Backdating is exactly how history is recorded; it must not be refused.
      assert.equal(response.status, 200, `PUT ${date} answered ${response.status}`);
    }

    const body = (await (await getStats(h, h.cookie, `?today=${TODAY}`)).json()) as StatsResponse;

    assert.equal(body.today, TODAY);
    assert.equal(body.stats.length, 1);
    assert.deepEqual(body.stats[0], {
      habit_id: habit.id,
      current_streak: 3,
      longest_streak: 3,
      achieved_days: 3,
      window_days: 30,
      achievement_rate: 3 / 30,
    });
    h.db.close();
  });

  it("ignores entries dated after the requested today", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "散歩", kind: "boolean" });

    await putEntry(h, h.cookie, habit.id, "2026-03-16", 1);
    await putEntry(h, h.cookie, habit.id, TODAY, 1);

    const body = (await (await getStats(h, h.cookie, `?today=${TODAY}`)).json()) as StatsResponse;

    assert.equal(body.stats[0]?.current_streak, 1);
    assert.equal(body.stats[0]?.achieved_days, 1);
    h.db.close();
  });

  it("drops an archived habit but keeps its entries in the table", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "瞑想", kind: "boolean" });
    await putEntry(h, h.cookie, habit.id, TODAY, 1);

    await h.app.fetch(request("DELETE", `/api/habits/${habit.id}`, h.cookie));

    const body = (await (await getStats(h, h.cookie, `?today=${TODAY}`)).json()) as StatsResponse;

    assert.deepEqual(body.stats, []);
    const remaining = h.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE habit_id = ?").get(habit.id) as {
      n: number;
    };
    assert.equal(remaining.n, 1, "logical delete must not remove history");
    h.db.close();
  });

  it("never mixes in another user's habits", async () => {
    const h = makeHarness();
    const mine = await createHabit(h, h.cookie, { name: "私の習慣", kind: "boolean" });
    const theirs = await createHabit(h, h.otherCookie, { name: "他人の習慣", kind: "boolean" });
    await putEntry(h, h.otherCookie, theirs.id, TODAY, 1);

    const body = (await (await getStats(h, h.cookie, `?today=${TODAY}`)).json()) as StatsResponse;

    assert.deepEqual(
      body.stats.map((s) => s.habit_id),
      [mine.id],
    );
    assert.equal(body.stats[0]?.current_streak, 0);
    h.db.close();
  });

  it("counts a numeric habit only on days that met the target", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "運動", kind: "numeric", target: 30, unit: "分" });

    await putEntry(h, h.cookie, habit.id, TODAY, 10);
    await putEntry(h, h.cookie, habit.id, "2026-03-14", 30);
    await putEntry(h, h.cookie, habit.id, "2026-03-13", 45);

    const body = (await (await getStats(h, h.cookie, `?today=${TODAY}`)).json()) as StatsResponse;

    assert.equal(body.stats[0]?.current_streak, 2, "today fell short but is not over");
    assert.equal(body.stats[0]?.longest_streak, 2);
    assert.equal(body.stats[0]?.achieved_days, 2);
    h.db.close();
  });
});
