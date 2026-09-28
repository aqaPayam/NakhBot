import { ConfirmedInternalBlocks, type OpaqueTokenStore } from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { postgresConfirmationBoundary } from './confirmed-support-store.js';
import { PostgresInternalBlockWorkflow } from './internal-block-store.js';
export class PostgresConfirmedInternalBlocks extends ConfirmedInternalBlocks {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    now: () => number = Date.now,
  ) {
    super(
      postgresConfirmationBoundary(database, tokens, key, now),
      new PostgresInternalBlockWorkflow(database),
    );
  }
}
