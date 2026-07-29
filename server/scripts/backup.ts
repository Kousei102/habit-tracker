/**
 * Writes a consistent single-file copy of the database.
 *
 *   npm run backup                    # -> data/backup-YYYY-MM-DD.db
 *   npm run backup -- /data/out.db    # explicit destination
 *
 * `cp habits.db` is not a backup. The database runs in WAL mode, so the newest
 * writes sit in the `-wal` sidecar and a copy of the main file alone silently
 * loses them. `VACUUM INTO` asks SQLite for a snapshot that is complete and
 * consistent on its own, and it does so while the server keeps serving.
 *
 * This opens the database directly rather than through openDb(): a backup has
 * no business running migrations on the file it is trying to preserve.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "../src/config.ts";

function defaultDestination(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(path.dirname(DB_PATH), `backup-${day}.db`);
}

const destination = path.resolve(process.argv[2] ?? defaultDestination());

if (!fs.existsSync(DB_PATH)) {
  console.error(`[backup] no database at ${DB_PATH}`);
  process.exit(1);
}

// VACUUM INTO refuses to overwrite, which would otherwise turn a re-run on the
// same day into an unexplained failure.
if (fs.existsSync(destination)) {
  console.error(`[backup] ${destination} already exists; remove it or pass another path`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });

const db = new DatabaseSync(DB_PATH, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

const { size } = fs.statSync(destination);
console.log(`[backup] ${DB_PATH} -> ${destination} (${(size / 1024).toFixed(0)} KB)`);
