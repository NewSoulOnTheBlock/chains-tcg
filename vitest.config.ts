import { defineConfig } from 'vitest/config';

// Front-end test runner. Scoped deliberately to `src/` so the root `npm test`
// does NOT sweep the `new-backend/` monorepo: those suites import the workspace
// package `@chains/shared`, which only resolves after `npm ci` inside
// new-backend/, and otherwise fail to load and turn the whole run red.
// Run the backend suite from new-backend/ with its own `npm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['new-backend/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
