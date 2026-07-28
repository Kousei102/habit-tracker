import { defineConfig, devices } from "@playwright/test";

// Harness self-check only. Deliberately has no webServer and no globalSetup, so it
// verifies that Chromium actually launches in this container without depending on
// a single line of application code.
export default defineConfig({
  testDir: ".",
  outputDir: "../tmp/smoke-results",
  reporter: [["list"]],
  timeout: 20_000,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
