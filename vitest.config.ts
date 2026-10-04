import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
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
    ],
  },
});
