import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@nakh/config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
      '@nakh/application': fileURLToPath(
        new URL('./packages/application/src/index.ts', import.meta.url),
      ),
      '@nakh/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@nakh/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@nakh/localization': fileURLToPath(
        new URL('./packages/localization/src/index.ts', import.meta.url),
      ),
      '@nakh/media-delivery': fileURLToPath(
        new URL('./packages/media-delivery/src/index.ts', import.meta.url),
      ),
      '@nakh/media-r2': fileURLToPath(new URL('./packages/media-r2/src/index.ts', import.meta.url)),
      '@nakh/persistence-postgres': fileURLToPath(
        new URL('./packages/persistence-postgres/src/index.ts', import.meta.url),
      ),
      '@nakh/queue-redis': fileURLToPath(
        new URL('./packages/queue-redis/src/index.ts', import.meta.url),
      ),
      '@nakh/telegram': fileURLToPath(new URL('./packages/telegram/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      exclude: ['**/dist/**', '**/src/cli/**', '**/src/main.ts'],
    },
  },
});
