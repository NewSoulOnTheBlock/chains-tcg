import { defineConfig } from 'vitest/config';

// Root config for the backend monorepo. Its main job is to EXIST: vitest
// searches parent directories for a config, and without this file a run from
// new-backend/ picks up <repo>/vitest.config.ts (the front-end runner), whose
// `vitest/config` import cannot resolve from this workspace's node_modules.
// The actual per-service settings live in services/*/vitest.config.ts and are
// stitched together by vitest.workspace.ts.
export default defineConfig({
  test: {
    environment: 'node',
  },
});
