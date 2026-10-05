import { defineConfig, devices } from "@playwright/test";

/**
 * Real-cell proof of the 03.1 owner's done-criterion (never part of `pnpm e2e`). It runs against the isolated stack
 * with a real OpenClaw cell started by scripts/cell-proof.sh:
 *   OCW_BUNDLED_PLUGINS=none OCW_E2E_API_HOST=0.0.0.0 OCW_E2E_CLAWHUB_URL=https://clawhub.ai \
 *     OCW_MOCK_MODEL_BASE_URL=http://fake-model:18999/v1 bash scripts/e2e-isolated.sh --cmd "bash scripts/cell-proof.sh"
 * CI: .github/workflows/cell-proof.yml (label `cell-proof`). Same base URLs and screenshot helper as the main config.
 */
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };

export default defineConfig({
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "./playwright-report", open: "never" }]],
  use: {
    baseURL: process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testDir: "./tests", testMatch: /setup\.spec\.ts/, use: desktop },
    {
      name: "proof",
      testDir: "./proof",
      testMatch: /\.proof\.ts$/,
      dependencies: ["setup"],
      use: desktop,
    },
  ],
});
