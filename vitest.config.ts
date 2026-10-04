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
