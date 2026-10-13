import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A stray .only silently narrows `pnpm verify` to one test; refuse it everywhere, locally as in CI (D-08).
    allowOnly: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "e2e/support/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**"],
          environment: "node",
          // Shared CI runners can take seconds for a file's first local HTTP/WebSocket round trip.
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/src/**/*.int.test.ts", "apps/*/src/**/*.int.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        // apps/web components rendered to static markup (renderToStaticMarkup, no DOM). Vite 8 transforms with
        // oxc; apps/web's tsconfig says `jsx: preserve` (Next compiles it), so the runtime is set here.
        oxc: { jsx: { runtime: "automatic" } },
        resolve: { alias: { "@": fileURLToPath(new URL("./apps/web", import.meta.url)) } },
        test: {
          name: "web",
          include: ["apps/web/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "apps/web/.next*/**"],
          environment: "node",
        },
      },
    ],
  },
});
