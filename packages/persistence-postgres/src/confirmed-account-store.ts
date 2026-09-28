import { ConfirmedAccountActions, type OpaqueTokenStore } from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { postgresConfirmationBoundary } from './confirmed-support-store.js';
import { PostgresAccountModerationWorkflow } from './account-moderation-store.js';
export class PostgresConfirmedAccountActions extends ConfirmedAccountActions {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    now: () => number = Date.now,
  ) {
    super(
      postgresConfirmationBoundary(database, tokens, key, now),
      new PostgresAccountModerationWorkflow(database),
    );
  }
}
