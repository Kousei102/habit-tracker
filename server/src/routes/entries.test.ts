import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Entry, Habit } from "../../../shared/types.ts";
import { createApp } from "../app.ts";
import { SESSION_COOKIE, createSession, hashPassword } from "../auth.ts";
import { CLIENT_DIST } from "../config.ts";
import { openDb } from "../db.ts";

/** Fixed dates, never `new Date()`: the API takes the day from the caller. */
const TODAY = "2026-03-15";
const YESTERDAY = "2026-03-14";

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

function request(method: string, path: string, cookie: string, body?: unknown): Request {
  const headers: Record<string, string> = { cookie };
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

function entryCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
}

describe("PUT /api/entries/:habitId/:date", () => {
  it("records a value for the requested date", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });

    const response = await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${TODAY}`, h.cookie, { value: 1 }));

    assert.equal(response.status, 200);
    const entry = (await response.json()) as Entry;
    assert.equal(entry.habit_id, habit.id);
    assert.equal(entry.date, TODAY);
    assert.equal(entry.value, 1);

    const row = h.db.prepare("SELECT date, value FROM entries WHERE habit_id = ?").get(habit.id) as {
      date: string;
      value: number;
    };
    // The stored date is the one from the URL — not one the server invented.
    assert.equal(row.date, TODAY);
    h.db.close();
  });

  it("AC-3.8: a second PUT for the same date overwrites instead of duplicating", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "ランニング", kind: "numeric", target: 30, unit: "分" });

    await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${TODAY}`, h.cookie, { value: 10 }));
    const second = await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${TODAY}`, h.cookie, { value: 42 }));

    assert.equal(second.status, 200);
    assert.equal(entryCount(h.db), 1);
    const row = h.db
      .prepare("SELECT value FROM entries WHERE habit_id = ? AND date = ?")
      .get(habit.id, TODAY) as { value: number };
    assert.equal(row.value, 42);
    h.db.close();
  });

  it("AC-3.8: a third PUT of 0 clears the value without removing the row", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });

    await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${TODAY}`, h.cookie, { value: 1 }));
    await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${TODAY}`, h.cookie, { value: 0 }));

    assert.equal(entryCount(h.db), 1);
    const row = h.db.prepare("SELECT value FROM entries WHERE habit_id = ?").get(habit.id) as { value: number };
    assert.equal(row.value, 0);
    h.db.close();
  });

  it("keeps different dates as separate rows", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });

    await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${YESTERDAY}`, h.cookie, { value: 1 }));
    await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${TODAY}`, h.cookie, { value: 1 }));

    assert.equal(entryCount(h.db), 2);
    h.db.close();
  });

  it("AC-3.7: a habit id that does not exist answers 404", async () => {
    const h = makeHarness();

    const response = await h.app.fetch(request("PUT", `/api/entries/4242/${TODAY}`, h.cookie, { value: 1 }));

    assert.equal(response.status, 404);
    assert.equal(entryCount(h.db), 0);
    h.db.close();
  });

  it("AC-3.7: another user's habit answers 404 — the same answer, leaking nothing", async () => {
    const h = makeHarness();
    const mine = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });

    const stranger = await h.app.fetch(request("PUT", `/api/entries/${mine.id}/${TODAY}`, h.otherCookie, { value: 1 }));
    const missing = await h.app.fetch(request("PUT", `/api/entries/4242/${TODAY}`, h.otherCookie, { value: 1 }));

    assert.equal(stranger.status, 404);
    assert.equal(missing.status, 404);
    // Byte-identical bodies: a different message would be an existence oracle.
    assert.equal(await stranger.text(), await missing.text());
    assert.equal(entryCount(h.db), 0);
    h.db.close();
  });

  it("AC-3.7: a non-numeric habit id answers 404, not 500", async () => {
    const h = makeHarness();

    const response = await h.app.fetch(request("PUT", `/api/entries/abc/${TODAY}`, h.cookie, { value: 1 }));

    assert.equal(response.status, 404);
    h.db.close();
  });

  it("answers 404 for an archived habit", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });
    await h.app.fetch(request("DELETE", `/api/habits/${habit.id}`, h.cookie));

    const response = await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${TODAY}`, h.cookie, { value: 1 }));

    assert.equal(response.status, 404);
    h.db.close();
  });

  it("rejects a malformed date with 400 and writes nothing", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });

    for (const date of ["2026-3-15", "15-03-2026", "2026-02-31", "today"]) {
      const response = await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${date}`, h.cookie, { value: 1 }));
      assert.equal(response.status, 400, `expected 400 for ${date}`);
    }

    assert.equal(entryCount(h.db), 0);
    h.db.close();
  });

  it("rejects a non-numeric or negative value with 400", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });

    for (const body of [{ value: "1" }, { value: -1 }, { value: null }, {}]) {
      const response = await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${TODAY}`, h.cookie, body));
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }

    assert.equal(entryCount(h.db), 0);
    h.db.close();
  });

  it("answers 401 without a session", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });

    const response = await h.app.fetch(
      request("PUT", `/api/entries/${habit.id}/${TODAY}`, `${SESSION_COOKIE}=nope`, { value: 1 }),
    );

    assert.equal(response.status, 401);
    h.db.close();
  });
});

describe("GET /api/entries", () => {
  it("returns only this user's entries", async () => {
    const h = makeHarness();
    const mine = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });
    const theirs = await createHabit(h, h.otherCookie, { name: "読書", kind: "boolean" });
    await h.app.fetch(request("PUT", `/api/entries/${mine.id}/${TODAY}`, h.cookie, { value: 1 }));
    await h.app.fetch(request("PUT", `/api/entries/${theirs.id}/${TODAY}`, h.otherCookie, { value: 1 }));

    const entries = (await (await h.app.fetch(request("GET", "/api/entries", h.cookie))).json()) as Entry[];

    assert.deepEqual(
      entries.map((entry) => entry.habit_id),
      [mine.id],
    );
    h.db.close();
  });

  it("filters by an inclusive date range", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });
    for (const date of ["2026-03-13", YESTERDAY, TODAY]) {
      await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${date}`, h.cookie, { value: 1 }));
    }

    const response = await h.app.fetch(
      request("GET", `/api/entries?from=${YESTERDAY}&to=${TODAY}`, h.cookie),
    );
    const entries = (await response.json()) as Entry[];

    assert.deepEqual(
      entries.map((entry) => entry.date),
      [YESTERDAY, TODAY],
    );
    h.db.close();
  });

  it("keeps the entries of an archived habit (AC-3.6)", async () => {
    const h = makeHarness();
    const habit = await createHabit(h, h.cookie, { name: "読書", kind: "boolean" });
    await h.app.fetch(request("PUT", `/api/entries/${habit.id}/${TODAY}`, h.cookie, { value: 1 }));
    await h.app.fetch(request("DELETE", `/api/habits/${habit.id}`, h.cookie));

    const entries = (await (await h.app.fetch(request("GET", "/api/entries", h.cookie))).json()) as Entry[];

    assert.equal(entries.length, 1);
    h.db.close();
  });

  it("rejects a malformed range with 400", async () => {
    const h = makeHarness();

    const response = await h.app.fetch(request("GET", "/api/entries?from=2026-3-1", h.cookie));

    assert.equal(response.status, 400);
    h.db.close();
  });

  it("answers 401 without a session", async () => {
    const h = makeHarness();

    const response = await h.app.fetch(request("GET", "/api/entries", `${SESSION_COOKIE}=nope`));

    assert.equal(response.status, 401);
    h.db.close();
  });
});
