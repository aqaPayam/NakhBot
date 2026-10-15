import { defineConfig } from 'vitest/config';
import { WORKSPACE_SOURCE_ALIASES } from './scripts/workspace-source-aliases.js';

export default defineConfig({
  resolve: {
    alias: WORKSPACE_SOURCE_ALIASES,
  },
  test: {
    include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Suites share one service database and legacy fixtures reset shared tables.
    // Races within each test still run concurrently via Promise.all.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
