import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb } from "./db.ts";
import {
  SESSION_TTL_MS,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  deleteSessionsForUser,
  findSessionUser,
  hashPassword,
  verifyPassword,
} from "./auth.ts";

const PASSWORD = "correct horse battery staple";

describe("hashPassword / verifyPassword", () => {
  it("never stores the plaintext password (AC-2.5)", () => {
    const stored = hashPassword(PASSWORD);

    assert.ok(!stored.includes(PASSWORD));
    assert.ok(!stored.includes("correct"));
    assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/);
  });

  it("accepts the right password", () => {
    assert.equal(verifyPassword(PASSWORD, hashPassword(PASSWORD)), true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword(PASSWORD);

    assert.equal(verifyPassword("wrong", stored), false);
    assert.equal(verifyPassword(`${PASSWORD} `, stored), false);
    assert.equal(verifyPassword("", stored), false);
  });

  it("salts each hash, so the same password hashes differently", () => {
    assert.notEqual(hashPassword(PASSWORD), hashPassword(PASSWORD));
  });

  it("returns false instead of throwing on a malformed stored value", () => {
    for (const stored of ["", ":", "noseparator", ":abcd", "abcd:", "zz:zz"]) {
      assert.equal(verifyPassword(PASSWORD, stored), false, `stored=${JSON.stringify(stored)}`);
    }
  });
});

function seedUser(username = "tester"): { db: ReturnType<typeof openDb>; userId: number } {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(
    username,
    hashPassword(PASSWORD),
    new Date().toISOString(),
  );
  const row = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as { id: number };
  return { db, userId: row.id };
}

describe("sessions", () => {
  it("issues a 64-hex-character token that resolves to its user", () => {
    const { db, userId } = seedUser();

    const session = createSession(db, userId);
    assert.match(session.token, /^[0-9a-f]{64}$/); // randomBytes(32) as hex

    // node:sqlite hands back null-prototype rows, so spread before comparing.
    assert.deepEqual({ ...findSessionUser(db, session.token) }, { id: userId, username: "tester" });
    db.close();
  });

  it("expires 30 days out", () => {
    const { db, userId } = seedUser();
    const now = new Date("2026-03-15T09:00:00.000Z");

    const session = createSession(db, userId, now);

    assert.equal(new Date(session.expiresAt).getTime() - now.getTime(), SESSION_TTL_MS);
    assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
    db.close();
  });

  it("does not resolve an unknown or expired token", () => {
    const { db, userId } = seedUser();
    const issuedAt = new Date("2026-03-15T09:00:00.000Z");
    const session = createSession(db, userId, issuedAt);

    assert.equal(findSessionUser(db, "deadbeef"), null);

    const justBefore = new Date(issuedAt.getTime() + SESSION_TTL_MS - 1000);
    const justAfter = new Date(issuedAt.getTime() + SESSION_TTL_MS + 1000);
    assert.notEqual(findSessionUser(db, session.token, justBefore), null);
    assert.equal(findSessionUser(db, session.token, justAfter), null);
    db.close();
  });

  it("forgets a deleted session", () => {
    const { db, userId } = seedUser();
    const session = createSession(db, userId);

    deleteSession(db, session.token);

    assert.equal(findSessionUser(db, session.token), null);
    db.close();
  });

  it("drops every session of a user when the password is reset", () => {
    const { db, userId } = seedUser();
    const a = createSession(db, userId);
    const b = createSession(db, userId);

    deleteSessionsForUser(db, userId);

    assert.equal(findSessionUser(db, a.token), null);
    assert.equal(findSessionUser(db, b.token), null);
    db.close();
  });

  it("sweeps expired rows only", () => {
    const { db, userId } = seedUser();
    const stale = createSession(db, userId, new Date("2020-01-01T00:00:00.000Z"));
    const fresh = createSession(db, userId);

    deleteExpiredSessions(db);

    const remaining = db.prepare("SELECT token FROM sessions").all() as { token: string }[];
    assert.deepEqual(
      remaining.map((r) => r.token),
      [fresh.token],
    );
    assert.equal(findSessionUser(db, stale.token), null);
    db.close();
  });
});
