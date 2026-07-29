import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * Builds the client once, before any server starts.
 *
 * Two servers serve `client/dist` in this run (see playwright.config.ts), and
 * `vite build` empties that directory before it fills it. Letting both server
 * commands build would have them racing over the same folder; building here
 * means the directory is complete and stable before either of them looks at it.
 */
export default function globalSetup(): void {
  execFileSync("npm", ["run", "build", "--workspace", "client"], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  const index = path.join(repoRoot, "client", "dist", "index.html");
  if (!fs.existsSync(index)) {
    throw new Error(`the build produced no ${index}`);
  }
}
