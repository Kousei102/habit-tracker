import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { openDb } from "./db.ts";
import { LATEST_VERSION, getSchemaVersion } from "./migrations.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "habit-migrations-"));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tempDbPath(name: string): string {
  return path.join(tmpDir, `${name}.db`);
}

function tableNames(db: ReturnType<typeof openDb>): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function schemaFingerprint(db: ReturnType<typeof openDb>): string {
  const rows = db
    .prepare("SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master ORDER BY type, name")
    .all() as { type: string; name: string; sql: string }[];
  return rows.map((row) => `${row.type}:${row.name}:${row.sql}`).join("\n");
}

describe("openDb / runMigrations", () => {
  it("creates the database file and the four tables", () => {
    const dbPath = tempDbPath("creates");
    const db = openDb(dbPath);

    assert.ok(fs.existsSync(dbPath), "database file should exist on disk");
    assert.deepEqual(tableNames(db), ["entries", "habits", "sessions", "users"]);
    assert.equal(getSchemaVersion(db), LATEST_VERSION);

    db.close();
  });

  it("enables foreign key enforcement on the connection", () => {
    const db = openDb(tempDbPath("pragmas"));

    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.equal(foreignKeys.foreign_keys, 1);

    // Not just the pragma value: the constraint must actually bite.
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO habits (user_id, name, kind, color, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(999, "orphan", "boolean", "green", "2026-03-15T00:00:00.000Z"),
      /FOREIGN KEY constraint failed/,
    );

    db.close();
  });

  it("is idempotent: opening the same database twice leaves the schema unchanged", () => {
    const dbPath = tempDbPath("idempotent");

    const first = openDb(dbPath);
    const fingerprintAfterFirst = schemaFingerprint(first);
    const versionAfterFirst = getSchemaVersion(first);
    first.close();

    // A second process start must not error and must not duplicate anything.
    const second = openDb(dbPath);
    assert.equal(schemaFingerprint(second), fingerprintAfterFirst);
    assert.equal(getSchemaVersion(second), versionAfterFirst);
    assert.deepEqual(tableNames(second), ["entries", "habits", "sessions", "users"]);
    second.close();

    // And a third, for good measure — this is the one that used to catch
    // "CREATE TABLE" without a version guard.
    const third = openDb(dbPath);
    assert.equal(schemaFingerprint(third), fingerprintAfterFirst);
    third.close();
  });

  it("keeps data written before a re-open", () => {
    const dbPath = tempDbPath("persists");

    const first = openDb(dbPath);
    first
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run("someone", "salt:hash", "2026-03-15T00:00:00.000Z");
    first.close();

    const second = openDb(dbPath);
    const row = second.prepare("SELECT username FROM users").get() as { username: string } | undefined;
    assert.equal(row?.username, "someone");
    second.close();
  });
});
