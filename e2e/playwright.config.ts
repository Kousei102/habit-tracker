import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

// E2E runs against the production path: the client is built and the Node server
// serves client/dist. One process, and the same wiring a deployment would use —
// so a bug in static serving surfaces here instead of after deploy.
const PORT = 3101;
const BASE_URL = `http://localhost:${PORT}`;

// Relative to repoRoot; global-setup wipes this before every run.
export const E2E_DB_PATH = ".harness/tmp/e2e.db";
export const E2E_USER = "e2e";
export const E2E_PASSWORD = "e2e-password";

export default defineConfig({
  testDir: "./specs",
  outputDir: path.join(repoRoot, ".harness/tmp/test-results"),
  globalSetup: "./global-setup.ts",

  fullyParallel: false, // one SQLite file, one server: parallel specs would race
  workers: 1,
  forbidOnly: true,
  retries: 0, // a flaky pass must not be mistaken for a pass
  timeout: 30_000,
  expect: { timeout: 5_000 },

  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(repoRoot, ".harness/tmp/playwright-report"), open: "never" }],
    // Machine-readable result so the reviewer reports counts it actually observed.
    ["json", { outputFile: path.join(repoRoot, ".harness/tmp/e2e-results.json") }],
  ],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: "npm run e2e:serve",
    cwd: repoRoot,
    url: `${BASE_URL}/api/health`,
    // Never reuse a dev server: it would run against the developer's own database.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      DB_PATH: E2E_DB_PATH,
      ADMIN_USER: E2E_USER,
      ADMIN_PASSWORD: E2E_PASSWORD,
      NODE_ENV: "production",
    },
  },
});
