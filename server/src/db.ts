import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrations.ts";

/**
 * Opens (creating if needed) the SQLite database, applies the pragmas the app
 * depends on, and migrates it.
 *
 * `foreign_keys` defaults to OFF in SQLite and is per-connection, so it must be
 * set here on every connection — otherwise the REFERENCES clauses in the schema
 * are decorative.
 */
export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  runMigrations(db);

  return db;
}
