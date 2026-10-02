import { defineConfig } from "@playwright/test";

// Electron smoke test: `pnpm --filter @ocw/desktop test:smoke` (builds first).
// Uses an isolated profile + OCW_HOME, a fake enrollment API, and the web app on :3000 if running.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts/,
  outputDir: "./test-results",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
});
