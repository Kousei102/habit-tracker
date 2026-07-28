/**
 * Creates (or re-passwords) the single admin user from the environment.
 *
 *   npm run seed-user            # loads .env, then ADMIN_USER / ADMIN_PASSWORD
 *
 * There is no signup screen (docs/design.md), so this script is the only way a
 * user comes into existence. It takes no arguments — everything comes from the
 * environment — because the E2E harness invokes the file directly with
 * DB_PATH / ADMIN_USER / ADMIN_PASSWORD set, and expects exit code 0.
 */
import { DB_PATH } from "../src/config.ts";
import { deleteSessionsForUser, hashPassword } from "../src/auth.ts";
import { openDb } from "../src/db.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`[seed-user] ${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const username = required("ADMIN_USER");
const password = required("ADMIN_PASSWORD");

const db = openDb(DB_PATH);

try {
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
    | { id: number }
    | undefined;

  if (existing === undefined) {
    db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(
      username,
      hashPassword(password),
      new Date().toISOString(),
    );
    console.log(`[seed-user] created user "${username}" in ${DB_PATH}`);
  } else {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), existing.id);
    // A password change must not leave old sessions usable.
    deleteSessionsForUser(db, existing.id);
    console.log(`[seed-user] updated password for "${username}" in ${DB_PATH}`);
  }
} finally {
  db.close();
}
