import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // Tests must never reach a real model; the real-session recorder lives in scripts/.
    env: { OCW_TEST: '1' },
  },
});
