import { sql } from 'kysely';
import {
  AdminActionAuthorizationService,
  ConfirmedAccountReturnApprovals,
  SelectAccountReturnApprovalHandler,
  type AccountReturnApprovalSelectionStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { requireNativeAdminSessions } from './admin-session-policy.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
import { postgresConfirmationBoundary } from './confirmed-support-store.js';
import { PostgresAccountReturnApprovalWorkflow } from './account-return-approval-store.js';

class PostgresReturnApprovalSelectionStore implements AccountReturnApprovalSelectionStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async get(rootId: string): ReturnType<AccountReturnApprovalSelectionStore['get']> {
    return (
      await sql<{ version: number; reviewable: boolean }>`SELECT account_version AS version,
      identity.account_return_reviewable(id) AS reviewable FROM identity.account_deletion_records WHERE id=${rootId}::uuid`.execute(
        this.database,
      )
    ).rows[0];
  }
}
export class PostgresSelectAccountReturnApprovalHandler extends SelectAccountReturnApprovalHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    requireNativeAdminSessions(database);
    const facts = new PostgresAdminAuthorizationStore(database);
    super(
      new PostgresAdminQueueIdentityStore(database),
      facts,
      new AdminActionAuthorizationService(facts, tokens, key),
      new PostgresReturnApprovalSelectionStore(database),
    );
  }
}
export class PostgresConfirmedAccountReturnApprovals extends ConfirmedAccountReturnApprovals {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      postgresConfirmationBoundary(database, tokens, key),
      new PostgresAccountReturnApprovalWorkflow(database),
    );
  }
}
