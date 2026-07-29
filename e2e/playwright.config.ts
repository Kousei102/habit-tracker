import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

// Phase 7 removed the server. There is no API to wait for and no database to
// wipe, so the suite runs against the built static files and nothing else.
//
// Two servers on purpose:
//
//   3101 — `vite preview`, which is what `npm run e2e:serve` starts. It has an
//          SPA fallback, so it is the friendlier of the two.
//   3102 — `python3 -m http.server`, a plain static file server with no
//          fallback, no rewriting and no Node process anywhere. AC-7.2 says the
//          build must run on "any static file server"; this is the one that
//          proves it, and it also catches an app that has quietly come to depend
//          on a fallback that a free static host may not give it.
// `vite preview` binds to `localhost` (which resolves to ::1 here) and not to
// 127.0.0.1, so the two servers are addressed the way each of them actually
// listens. A useful side effect: they are different origins, so the static-host
// spec cannot accidentally read data another spec left behind.
const PORT = 3101;
const BASE_URL = `http://localhost:${PORT}`;

const STATIC_PORT = 3102;
/** Absolute, because the spec that uses it navigates outside `baseURL`. */
export const STATIC_URL = `http://127.0.0.1:${STATIC_PORT}`;

export default defineConfig({
  testDir: "./specs",
  outputDir: path.join(repoRoot, ".harness/tmp/test-results"),

  // Builds once, before either server starts — both of them serve the same
  // directory and `vite build` empties it first.
  globalSetup: path.join(repoRoot, "e2e/global-setup.ts"),

  // The data now lives in each browser context's own localStorage, so specs no
  // longer share a database — but the two servers are shared, and keeping the
  // run serial keeps failures readable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0, // a flaky pass must not be mistaken for a pass
  timeout: 60_000,
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

  webServer: [
    {
      // Builds the client and serves client/dist. No database, no environment.
      command: "npm run e2e:serve",
      cwd: repoRoot,
      // The app itself, not an API health route — there is no API left.
      url: `${BASE_URL}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Deliberately not Node. `npm run e2e:serve` above has already produced
      // the build; this only serves the bytes.
      command: `python3 -m http.server ${STATIC_PORT} --bind 127.0.0.1 --directory client/dist`,
      cwd: repoRoot,
      url: `${STATIC_URL}/index.html`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
