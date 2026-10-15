import { defineConfig } from 'vitest/config';
import { WORKSPACE_SOURCE_ALIASES } from './scripts/workspace-source-aliases.js';

export default defineConfig({
  resolve: {
    alias: WORKSPACE_SOURCE_ALIASES,
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      exclude: ['**/dist/**', '**/src/cli/**', '**/src/main.ts'],
    },
  },
});
