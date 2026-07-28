import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { E2E_DB_PATH, E2E_PASSWORD, E2E_USER } from "./playwright.config.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * Wipes the E2E database and seeds the single user — as the first step of the
 * `webServer` command, before the server process starts.
 *
 * This used to be a `globalSetup`. Playwright starts `webServer` *before*
 * globalSetup runs, so the server had already opened (and created) the database
 * file by the time globalSetup unlinked it. SQLite happily keeps serving the
 * unlinked inode, so the server never saw the seeded user: on a clean checkout
 * every login failed, and on every later run the suite passed against the
 * *previous* run's leftover database — exactly the failure mode wiping was
 * supposed to prevent. Preparing the file inside the server command removes the
 * ordering question instead of relying on it.
 *
 * Every run therefore starts from an identical database: one user, no habits,
 * no entries, no sessions.
 */
const dbPath = path.join(repoRoot, E2E_DB_PATH);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// WAL mode leaves -wal and -shm sidecars; deleting only the .db keeps stale pages.
for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(dbPath + suffix, { force: true });
}

execFileSync("node", ["--disable-warning=ExperimentalWarning", path.join(repoRoot, "server/scripts/seed-user.ts")], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    DB_PATH: E2E_DB_PATH,
    ADMIN_USER: E2E_USER,
    ADMIN_PASSWORD: E2E_PASSWORD,
  },
});
