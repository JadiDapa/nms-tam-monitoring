import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Real UDP agents + embedded Postgres instances: keep files sequential for determinism.
    fileParallelism: false,
  },
});
