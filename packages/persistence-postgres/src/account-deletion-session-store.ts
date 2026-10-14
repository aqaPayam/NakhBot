import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

function conflict(): never {
  throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
/** Security revocation under the actual deletion lease, not a forged user logout.
 * Independent native inventory ignores Account tombstones when proving authority
 * dead. This component cannot advance the whole ephemeral checkpoint. */
export class PostgresAccountDeletionSessionStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(private readonly database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  private validate(lease: AccountDeletionLease): void {
    if (!(
      (lease.phase === 'ephemeral_access' && lease.checkpointVersion === 5) ||
      (lease.phase === 'verification' && lease.checkpointVersion === 7)
    ))
      conflict();
  }
  private async blocker(
    transaction: NakhDatabase,
    scope: AccountDeletionLease,
  ): Promise<string | null> {
    const row = (
      await sql<{
        blocker: string | null;
      }>`SELECT identity.deletion_session_blocker(${scope.deletionRecordId}::uuid,${scope.userId}::uuid) AS blocker`.execute(
        transaction,
      )
    ).rows[0];
    if (row === undefined || (row.blocker !== null && row.blocker !== 'sessions')) conflict();
    return row.blocker;
  }
  public async revokeNext(
    lease: AccountDeletionLease,
    limit = 100,
  ): Promise<Readonly<{ revoked: number; hasMore: boolean }>> {
    this.validate(lease);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) conflict();
    return this.work.withLease(lease, async (transaction, scope) => {
      assertDeletionCatalogCoverage(await readDeletionCatalog(transaction));
      if ((await this.blocker(transaction, scope)) === null) return { revoked: 0, hasMore: false };
      const sources = (
        await sql<{ id: string }>`SELECT source.id FROM platform.audit_logs source
        JOIN identity.account_deletion_records root ON root.id=${scope.deletionRecordId}::uuid
        WHERE source.event_type='identity.user-session-issued.v1' AND source.actor_user_id=root.user_id
          AND identity.user_session_epoch(source.id)=root.product_epoch
          AND (source.metadata->>'expiresAt')::timestamptz>clock_timestamp()
          AND NOT identity.user_session_authority_revoked(source.id)
        ORDER BY source.id LIMIT ${limit}`.execute(transaction)
      ).rows;
      if (sources.length === 0)
        return { revoked: 0, hasMore: (await this.blocker(transaction, scope)) !== null };
      const id = randomUUID(),
        ids = sources.map((source) => source.id);
      const result =
        await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,
        subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
        SELECT ${id}::uuid,'security','identity.user-session-root-revoked.v1','system',NULL,NULL,
          'account_deletion',root.id,'deletion_sessions_revoked',1,
          jsonb_build_object('grantIds',to_jsonb(${ids}::uuid[]),'rows',${ids.length}::integer,'productEpoch',root.product_epoch,
            'owner',job.lease_owner,'generation',job.lease_generation,'leaseExpiresAt',job.lease_expires_at,'transactionId',pg_current_xact_id()::text),
          root.command_id,root.request_id,clock_timestamp()
        FROM identity.account_deletion_records root JOIN identity.account_deletion_work job ON job.deletion_record_id=root.id
        WHERE root.id=${scope.deletionRecordId}::uuid RETURNING id`.execute(transaction);
      if (result.rows.length !== 1) conflict();
      await sql`INSERT INTO identity.account_deletion_session_receipts(audit_id,deletion_record_id,proof_hash)
        VALUES(${id}::uuid,${scope.deletionRecordId}::uuid,identity.deletion_session_digest(${id}::uuid))`.execute(
        transaction,
      );
      return { revoked: ids.length, hasMore: (await this.blocker(transaction, scope)) !== null };
    });
  }
  public async verify(lease: AccountDeletionLease): Promise<Readonly<{ verified: boolean }>> {
    this.validate(lease);
    return this.work.withLease(lease, async (transaction, scope) => {
      assertDeletionCatalogCoverage(await readDeletionCatalog(transaction));
      return { verified: (await this.blocker(transaction, scope)) === null };
    });
  }
}
