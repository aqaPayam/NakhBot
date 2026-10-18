import {
  AccountModerationWorkflow,
  ConfirmedAccountActions,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from '../database.js';
import { PostgresAccountModerationStore } from '../account-moderation-store.js';
import { postgresConfirmationBoundary } from '../confirmed-support-store.js';
import { SystemIdGenerator } from '../foundation-store.js';
import { PreRuntimeAdminCommandStore } from './pre-runtime-admin-command-store.js';

/** Historical data setup only: preserve the original confirmation, native
 * command transaction and action closure without installing migration 162 early. */
export class PreRuntimeConfirmedAccountActions extends ConfirmedAccountActions {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    now: () => number = Date.now,
  ) {
    super(
      postgresConfirmationBoundary(database, tokens, key, now),
      new AccountModerationWorkflow(
        new PreRuntimeAdminCommandStore(database),
        new PostgresAccountModerationStore(),
        new SystemIdGenerator(),
      ),
    );
  }
}
