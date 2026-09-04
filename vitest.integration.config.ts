import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
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
      '@nakh/persistence-postgres': fileURLToPath(
        new URL('./packages/persistence-postgres/src/index.ts', import.meta.url),
      ),
      '@nakh/telegram': fileURLToPath(new URL('./packages/telegram/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    sequence: { concurrent: false },
  },
});
