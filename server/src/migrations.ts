import type { DatabaseSync } from "node:sqlite";

type Migration = {
  version: number;
  sql: string;
};

/**
 * Migrations are applied in order and gated by `PRAGMA user_version`, so running
 * them against an already-migrated database is a no-op. Never edit a migration
 * that has shipped — append a new one instead.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS habits (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('boolean','numeric')),
        target REAL,
        unit TEXT,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entries (
        habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        value REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (habit_id, date)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
      CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);
    `,
  },
];

/** Schema version this build expects once all migrations have been applied. */
export const LATEST_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Applies every migration newer than the database's current `user_version`.
 * Idempotent: a second call on the same database applies nothing.
 *
 * @returns the schema version after migrating.
 */
export function runMigrations(db: DatabaseSync): number {
  let current = getSchemaVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      // PRAGMA does not accept bound parameters; the value is a literal from
      // this file, never user input.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    current = migration.version;
  }

  return current;
}
