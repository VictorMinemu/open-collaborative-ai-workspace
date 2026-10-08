import { defineConfig, devices } from "@playwright/test";

/**
 * Scenario B on the compose stack (SELF-07, D-09): the images an operator runs, behind Caddy on one HTTPS origin.
 * Run by `pnpm gate:compose` (scripts/gate/compose-gate.mjs), which builds and boots an isolated `ocw-gate-*` stack,
 * then runs this config from the host with its env: OCW_E2E_BASE_URL = OCW_E2E_API_URL = https://localhost:<NN43>,
 * OCW_SETUP_TOKEN (from the gate's env file, never the repository's .env), OCW_E2E_JSON_REPORT (the report the gate
 * reads: it fails on any skipped test, or when none ran), optionally OCW_E2E_SCREENSHOT_DIR and OCW_E2E_OUTPUT_DIR.
 *
 * Projects: `setup` redeems the setup token on the fresh stack, then `desktop` (1440×900) and `mobile` (390×844) run
 * Scenario B; the attachments API flow is viewport-independent and assigned to `desktop` only (it self-skips
 * elsewhere, and the gate accepts no skipped test). No retries: a flaky pass is not a pass.
 */
const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (pnpm gate:compose sets it)`);
  return v;
};

export default defineConfig({
  testDir: ".",
  outputDir: process.env.OCW_E2E_OUTPUT_DIR ?? "./test-results/compose",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.OCW_E2E_JSON_REPORT ?? "./test-results/compose/report.json" }],
  ],
  use: {
    baseURL: required("OCW_E2E_BASE_URL"),
    // Caddy's local CA (`localhost` site) is not in the browser's trust store; the Node-side gate checks verify it.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /tests\/setup\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "desktop",
      testMatch: [/compose\/.*\.spec\.ts$/, /tests\/attachments-api\.spec\.ts$/],
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /compose\/.*\.spec\.ts$/,
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
});
