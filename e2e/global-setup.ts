import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { E2E_DB_PATH, E2E_PASSWORD, E2E_USER } from "./playwright.config.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

// Every run starts from an identical, empty database. Without this, a spec that
// passes only because a previous run left data behind looks indistinguishable
// from one that genuinely passes.
export default function globalSetup() {
  const dbPath = path.join(repoRoot, E2E_DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // WAL mode leaves -wal and -shm sidecars; deleting only the .db keeps stale pages.
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }

  // The seed script arrives in Phase 2. Before then there is nothing to seed,
  // so the harness can already run against Phase 1 without it.
  const seedScript = path.join(repoRoot, "server/scripts/seed-user.ts");
  if (!fs.existsSync(seedScript)) return;

  execFileSync("node", ["--disable-warning=ExperimentalWarning", seedScript], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DB_PATH: E2E_DB_PATH,
      ADMIN_USER: E2E_USER,
      ADMIN_PASSWORD: E2E_PASSWORD,
    },
  });
}
