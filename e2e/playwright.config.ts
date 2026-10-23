import { defineConfig, devices } from "@playwright/test";
import { screenshotSpecsFromArgv } from "./support/screenshots";

/**
 * E2E against a running stack (compose or `pnpm dev`):
 *   docker compose -f compose.yaml -f compose.e2e.yaml up -d --build --wait && pnpm e2e
 * Use a FRESH stack (`docker compose down -v` first): the `setup` project redeems the setup token.
 * Env: OCW_E2E_BASE_URL (default http://localhost:3000), OCW_E2E_API_URL (default http://localhost:4000),
 * OCW_SETUP_TOKEN (default: read from ../.env), OCW_E2E_SCREENSHOT_DIR (optional: save review screenshots).
 * Screenshots are written only by the specs named on the command line (all of them on a run without spec filters);
 * OCW_E2E_SCREENSHOT_SPECS overrides that list (support/screenshots.ts).
 */
// The runner (not a worker) records the specs this run names; the workers inherit it and `shot()` reads it.
if (process.env.OCW_E2E_SCREENSHOT_SPECS === undefined && !process.env.TEST_WORKER_INDEX) {
  const specs = screenshotSpecsFromArgv(process.argv);
  if (specs !== undefined) process.env.OCW_E2E_SCREENSHOT_SPECS = specs;
}
export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // CI safety net: the whole run gets 15 minutes (a full desktop run takes about 6), inside the job's 30 (ci.yml).
  // Anything that outlives the per-test timeout (a test with its timeout disabled, a teardown that never settles, a
  // stuck worker) then fails fast with a report instead of running into the job timeout, which cancels the job and
  // skips the failure artifacts.
  globalTimeout: process.env.CI ? 15 * 60_000 : 0,
  reporter: [["list"], ["html", { outputFolder: "./playwright-report", open: "never" }]],
  use: {
    baseURL: process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /setup\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "desktop",
      testIgnore: /setup\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testIgnore: /setup\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
});
