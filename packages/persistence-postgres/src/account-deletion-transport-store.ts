import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionTransportBatchResult = Readonly<{
  purgedRows: number;
  hasMore: boolean;
  waitingForExpiry: boolean;
}>;
const registrationScope = (
  subject: string,
): RawBuilder<boolean> => sql<boolean>`actor_user_id=${subject}::uuid OR
  (scope='identity.register-telegram-identity' AND response_json#>>'{context,userId}'=${subject}::text)`;
/** Bounded actor-owned response cleanup and expired two-sided media authority.
 * Provider message receipts remain for the later provider-verification phase. */
export class PostgresAccountDeletionTransportStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  public async purgeNext(lease: AccountDeletionLease): Promise<DeletionTransportBatchResult> {
    if (lease.phase !== 'product_data' || lease.checkpointVersion !== 3)
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    try {
      return await this.work.withLease(lease, async (tx, scope) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const [grants, responses] = (
          await sql<{ grants: boolean; responses: boolean }>`SELECT
        EXISTS(SELECT 1 FROM media.delivery_grants WHERE ${scope.userId}::uuid IN(actor_user_id,owner_user_id)) AS grants,
        EXISTS(SELECT 1 FROM platform.idempotency_records WHERE ${registrationScope(scope.userId)}) AS responses`.execute(
            tx,
          )
        ).rows.map((r) => [r.grants, r.responses] as const)[0]!;
        let resource: number, removed: number;
        if (responses) {
          resource = 10;
          removed = (
            await sql`WITH doomed AS MATERIALIZED(SELECT id FROM platform.idempotency_records
          WHERE ${registrationScope(scope.userId)} ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED)
          DELETE FROM platform.idempotency_records source USING doomed WHERE source.id=doomed.id RETURNING source.id`.execute(
              tx,
            )
          ).rows.length;
        } else if (grants) {
          const mismatch = (
            await sql<{ mismatch: boolean }>`SELECT EXISTS(SELECT 1 FROM media.delivery_grants
          WHERE (${scope.userId}::uuid=actor_user_id AND actor_product_epoch<>(SELECT product_epoch FROM identity.account_deletion_records WHERE id=${scope.deletionRecordId}::uuid))
            OR (${scope.userId}::uuid=owner_user_id AND owner_product_epoch<>(SELECT product_epoch FROM identity.account_deletion_records WHERE id=${scope.deletionRecordId}::uuid))) AS mismatch`.execute(
              tx,
            )
          ).rows[0]!.mismatch;
          if (mismatch) throw Error('Transport original life mismatch');
          resource = 9;
          removed = (
            await sql`WITH doomed AS MATERIALIZED(SELECT id FROM media.delivery_grants
          WHERE ${scope.userId}::uuid IN(actor_user_id,owner_user_id) AND expires_at<=clock_timestamp() ORDER BY id LIMIT 100 FOR UPDATE)
          DELETE FROM media.delivery_grants source USING doomed WHERE source.id=doomed.id RETURNING source.id`.execute(
              tx,
            )
          ).rows.length;
          if (removed === 0) return { purgedRows: 0, hasMore: true, waitingForExpiry: true };
        } else return { purgedRows: 0, hasMore: false, waitingForExpiry: false };
        // Command admission can own its response row before locking this User.
        // Never wait for that row while holding the User/Account deletion fence.
        if (removed === 0) return { purgedRows: 0, hasMore: true, waitingForExpiry: false };
        if (removed > 100) throw Error('Transport removal incomplete');
        const audit = randomUUID(),
          event = randomUUID();
        const facts = (
          await sql<{
            command: string;
            request: string;
            at: string;
          }>`SELECT command_id AS command,request_id AS request,clock_timestamp()::text AS at
        FROM identity.account_deletion_records WHERE id=${scope.deletionRecordId}::uuid`.execute(tx)
        ).rows[0]!;
        const auditResult =
          await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
        VALUES(${audit}::uuid,'account','account.deletion-product-batch.v1','system','account_deletion',${scope.deletionRecordId}::uuid,'product_batch_purged',1,
          jsonb_build_object('resource',${resource}::integer,'rows',${removed}::integer,'eventId',${event}::uuid,'owner',${scope.leaseOwner}::uuid,'generation',${scope.leaseGeneration}::integer,
            'leaseExpiresAt',(SELECT lease_expires_at FROM identity.account_deletion_work WHERE deletion_record_id=${scope.deletionRecordId}::uuid)),${facts.command}::uuid,${facts.request}::uuid,${facts.at}) RETURNING id`.execute(
            tx,
          );
        const eventResult =
          await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
        VALUES(${event}::uuid,'account_deletion',${scope.deletionRecordId}::uuid,'account.deletion-product-batch.v1',1,
          jsonb_build_object('deletionRecordId',${scope.deletionRecordId}::uuid,'resource',${resource}::integer,'rows',${removed}::integer,'auditId',${audit}::uuid),
          ${facts.at},${facts.at},${facts.request}::uuid,${facts.command}::uuid) RETURNING id`.execute(
            tx,
          );
        if (auditResult.rows.length !== 1 || eventResult.rows.length !== 1)
          throw Error('Transport mandatory proof missing');
        const remaining = (
          await sql<{
            remaining: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM media.delivery_grants WHERE ${scope.userId}::uuid IN(actor_user_id,owner_user_id))
        OR EXISTS(SELECT 1 FROM platform.idempotency_records WHERE ${registrationScope(scope.userId)}) AS remaining`.execute(
            tx,
          )
        ).rows[0]!.remaining;
        return { purgedRows: removed, hasMore: remaining, waitingForExpiry: false };
      });
    } catch {
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    }
  }
}
