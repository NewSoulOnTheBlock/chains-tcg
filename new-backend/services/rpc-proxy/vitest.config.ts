import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // rpc-proxy tests are pure; keep them serial for stable timing assertions.

    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
