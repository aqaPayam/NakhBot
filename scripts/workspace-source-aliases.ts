import { fileURLToPath } from 'node:url';

/** Tests resolve current workspace source; native shards never require built artifacts.
 * Subpath entries precede package prefixes because Vite uses the first matching alias. */
export const WORKSPACE_SOURCE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '@nakh/media-delivery/edge': fileURLToPath(
    new URL('../packages/media-delivery/src/edge.ts', import.meta.url),
  ),
  '@nakh/media-delivery/worker': fileURLToPath(
    new URL('../packages/media-delivery/src/worker.ts', import.meta.url),
  ),
  '@nakh/application': fileURLToPath(
    new URL('../packages/application/src/index.ts', import.meta.url),
  ),
  '@nakh/config': fileURLToPath(new URL('../packages/config/src/index.ts', import.meta.url)),
  '@nakh/contracts': fileURLToPath(new URL('../packages/contracts/src/index.ts', import.meta.url)),
  '@nakh/domain': fileURLToPath(new URL('../packages/domain/src/index.ts', import.meta.url)),
  '@nakh/localization': fileURLToPath(
    new URL('../packages/localization/src/index.ts', import.meta.url),
  ),
  '@nakh/media-clamav': fileURLToPath(
    new URL('../packages/media-clamav/src/index.ts', import.meta.url),
  ),
  '@nakh/media-delivery': fileURLToPath(
    new URL('../packages/media-delivery/src/index.ts', import.meta.url),
  ),
  '@nakh/media-r2': fileURLToPath(new URL('../packages/media-r2/src/index.ts', import.meta.url)),
  '@nakh/observability': fileURLToPath(
    new URL('../packages/observability/src/index.ts', import.meta.url),
  ),
  '@nakh/persistence-postgres': fileURLToPath(
    new URL('../packages/persistence-postgres/src/index.ts', import.meta.url),
  ),
  '@nakh/queue-redis': fileURLToPath(
    new URL('../packages/queue-redis/src/index.ts', import.meta.url),
  ),
  '@nakh/telegram': fileURLToPath(new URL('../packages/telegram/src/index.ts', import.meta.url)),
  '@nakh/testkit': fileURLToPath(new URL('../packages/testkit/src/index.ts', import.meta.url)),
});
