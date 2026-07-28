import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Habit } from "../../../shared/types.ts";
import { createApp } from "../app.ts";
import { SESSION_COOKIE, createSession, hashPassword } from "../auth.ts";
import { CLIENT_DIST } from "../config.ts";
import { openDb } from "../db.ts";

/**
 * Route-level tests for Phase 3's habit CRUD.
 *
 * They run against the real Hono app and a real (in-memory) SQLite database, so
 * the SQL — including the `user_id` scoping the acceptance criteria hinge on —
 * is what is under test, not a mock of it.
 */

type Harness = {
  app: ReturnType<typeof createApp>;
  db: DatabaseSync;
  /** Cookie header for the primary user. */
  cookie: string;
  /** Cookie header for a second user, used for the cross-tenant checks. */
  otherCookie: string;
  otherUserId: number;
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
    otherUserId,
  };
}

function request(method: string, path: string, cookie: string, body?: unknown): Request {
  const headers: Record<string, string> = { cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createHabit(h: Harness, body: unknown): Promise<Habit> {
  const response = await h.app.fetch(request("POST", "/api/habits", h.cookie, body));
  // Read the body once: building a failure message from it would consume it.
  const payload = await response.json();
  assert.equal(response.status, 201, `expected 201, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload as Habit;
}

const CHECK_HABIT = { name: "読書", kind: "boolean" };
const NUMERIC_HABIT = { name: "ランニング", kind: "numeric", target: 30, unit: "分" };

describe("POST /api/habits", () => {
  it("AC-3.1: creates a boolean habit and lists it", async () => {
    const h = makeHarness();

    const created = await createHabit(h, CHECK_HABIT);
    assert.equal(created.name, "読書");
    assert.equal(created.kind, "boolean");
    assert.equal(created.archived_at, null);

    const list = (await (await h.app.fetch(request("GET", "/api/habits", h.cookie))).json()) as Habit[];
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, created.id);
    h.db.close();
  });

  it("AC-3.2: keeps target and unit for a numeric habit", async () => {
    const h = makeHarness();

    const created = await createHabit(h, NUMERIC_HABIT);

    assert.equal(created.kind, "numeric");
    assert.equal(created.target, 30);
    assert.equal(created.unit, "分");
    h.db.close();
  });

  it("forces target and unit to null for a boolean habit", async () => {
    const h = makeHarness();

    // A client that sends a target for a check-style habit must not end up with
    // a row that `isAchieved()` would read as numeric.
    const created = await createHabit(h, { ...CHECK_HABIT, target: 30, unit: "分" });

    assert.equal(created.target, null);
    assert.equal(created.unit, null);
    h.db.close();
  });

  it("rejects a numeric habit without a target", async () => {
    const h = makeHarness();

    const response = await h.app.fetch(
      request("POST", "/api/habits", h.cookie, { name: "ランニング", kind: "numeric" }),
    );

    assert.equal(response.status, 400);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM habits").get() as { n: number }).n, 0);
    h.db.close();
  });

  it("rejects a blank name, an unknown kind and a non-positive target", async () => {
    const h = makeHarness();

    for (const body of [
      { name: "   ", kind: "boolean" },
      { name: "x", kind: "counter" },
      { name: "x", kind: "numeric", target: 0 },
      { name: "x", kind: "numeric", target: -3 },
      { name: "x", kind: "numeric", target: "30" },
      { name: "x", kind: "boolean", color: "chartreuse" },
    ]) {
      const response = await h.app.fetch(request("POST", "/api/habits", h.cookie, body));
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }

    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM habits").get() as { n: number }).n, 0);
    h.db.close();
  });

  it("stores the habit against the calling user", async () => {
    const h = makeHarness();

    const created = await createHabit(h, CHECK_HABIT);

    const row = h.db.prepare("SELECT user_id FROM habits WHERE id = ?").get(created.id) as { user_id: number };
    assert.notEqual(row.user_id, h.otherUserId);
    h.db.close();
  });
});

describe("GET /api/habits", () => {
  it("never returns another user's habits", async () => {
    const h = makeHarness();
    await createHabit(h, CHECK_HABIT);

    const response = await h.app.fetch(request("GET", "/api/habits", h.otherCookie));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    h.db.close();
  });

  it("orders habits by sort_order", async () => {
    const h = makeHarness();
    const first = await createHabit(h, { name: "A", kind: "boolean" });
    const second = await createHabit(h, { name: "B", kind: "boolean" });

    const list = (await (await h.app.fetch(request("GET", "/api/habits", h.cookie))).json()) as Habit[];

    assert.deepEqual(
      list.map((habit) => habit.id),
      [first.id, second.id],
    );
    assert.ok((second.sort_order ?? 0) > (first.sort_order ?? 0));
    h.db.close();
  });
});

describe("PATCH /api/habits/:id", () => {
  it("AC-3.5: updates the name and the target", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, NUMERIC_HABIT);

    const response = await h.app.fetch(
      request("PATCH", `/api/habits/${habit.id}`, h.cookie, { name: "ジョギング", target: 45 }),
    );

    assert.equal(response.status, 200);
    const updated = (await response.json()) as Habit;
    assert.equal(updated.name, "ジョギング");
    assert.equal(updated.target, 45);
    // Untouched fields survive a partial update.
    assert.equal(updated.unit, "分");
    h.db.close();
  });

  it("rejects a change of kind rather than silently ignoring it", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, CHECK_HABIT);

    const response = await h.app.fetch(
      request("PATCH", `/api/habits/${habit.id}`, h.cookie, { kind: "numeric", target: 10 }),
    );

    assert.equal(response.status, 400);
    h.db.close();
  });

  it("AC-3.7 shape: another user's habit is a 404, not a 403", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, CHECK_HABIT);

    const response = await h.app.fetch(request("PATCH", `/api/habits/${habit.id}`, h.otherCookie, { name: "乗っ取り" }));

    assert.equal(response.status, 404);
    const stored = h.db.prepare("SELECT name FROM habits WHERE id = ?").get(habit.id) as { name: string };
    assert.equal(stored.name, "読書");
    h.db.close();
  });

  it("rejects an invalid name without touching the row", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, CHECK_HABIT);

    const response = await h.app.fetch(request("PATCH", `/api/habits/${habit.id}`, h.cookie, { name: "" }));

    assert.equal(response.status, 400);
    const stored = h.db.prepare("SELECT name FROM habits WHERE id = ?").get(habit.id) as { name: string };
    assert.equal(stored.name, "読書");
    h.db.close();
  });

  it("answers 404 for an id that does not exist", async () => {
    const h = makeHarness();

    const missing = await h.app.fetch(request("PATCH", "/api/habits/999", h.cookie, { name: "x" }));
    const notAnId = await h.app.fetch(request("PATCH", "/api/habits/abc", h.cookie, { name: "x" }));

    assert.equal(missing.status, 404);
    assert.equal(notAnId.status, 404);
    h.db.close();
  });
});

describe("DELETE /api/habits/:id", () => {
  it("AC-3.6: archives the habit and keeps its entries", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, CHECK_HABIT);
    await h.app.fetch(request("PUT", `/api/entries/${habit.id}/2026-03-14`, h.cookie, { value: 1 }));

    const response = await h.app.fetch(request("DELETE", `/api/habits/${habit.id}`, h.cookie));
    assert.equal(response.status, 200);

    // Gone from the list...
    const list = (await (await h.app.fetch(request("GET", "/api/habits", h.cookie))).json()) as Habit[];
    assert.deepEqual(list, []);

    // ...but the row is archived, not deleted, and the record is still there.
    const row = h.db.prepare("SELECT archived_at FROM habits WHERE id = ?").get(habit.id) as
      | { archived_at: string | null }
      | undefined;
    assert.ok(row, "the habit row must still exist");
    assert.notEqual(row?.archived_at, null);

    const entries = h.db.prepare("SELECT date, value FROM entries WHERE habit_id = ?").all(habit.id);
    assert.equal(entries.length, 1);
    h.db.close();
  });

  it("AC-3.7 shape: another user cannot archive the habit", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, CHECK_HABIT);

    const response = await h.app.fetch(request("DELETE", `/api/habits/${habit.id}`, h.otherCookie));

    assert.equal(response.status, 404);
    const row = h.db.prepare("SELECT archived_at FROM habits WHERE id = ?").get(habit.id) as {
      archived_at: string | null;
    };
    assert.equal(row.archived_at, null);
    h.db.close();
  });

  it("answers 404 the second time", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, CHECK_HABIT);

    assert.equal((await h.app.fetch(request("DELETE", `/api/habits/${habit.id}`, h.cookie))).status, 200);
    assert.equal((await h.app.fetch(request("DELETE", `/api/habits/${habit.id}`, h.cookie))).status, 404);
    h.db.close();
  });
});

describe("habit routes require a session", () => {
  it("answers 401 for every verb without a cookie", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, CHECK_HABIT);
    const noCookie = `${SESSION_COOKIE}=nope`;

    for (const [method, path, body] of [
      ["GET", "/api/habits", undefined],
      ["POST", "/api/habits", CHECK_HABIT],
      ["PATCH", `/api/habits/${habit.id}`, { name: "x" }],
      ["DELETE", `/api/habits/${habit.id}`, undefined],
    ] as const) {
      const response = await h.app.fetch(request(method, path, noCookie, body));
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    h.db.close();
  });
});
