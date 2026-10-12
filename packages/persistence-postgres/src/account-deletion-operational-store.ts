import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionOperationalBatchResult = Readonly<{
  cancelledRows: number;
  hasMore: boolean;
  waitingForLease: boolean;
  blockedBy: 'unclassified' | 'ordinary_content' | 'proof_invalid' | null;
}>;

/** Cancels ordinary publication only. Financial corrections, safety/lifecycle
 * proof and their original payloads remain available. No release or completion. */
export class PostgresAccountDeletionOperationalStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  public async cancelNext(lease: AccountDeletionLease): Promise<DeletionOperationalBatchResult> {
    if (lease.phase !== 'product_data' || lease.checkpointVersion !== 3)
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    try {
      return await this.work.withLease(lease, async (tx, scope) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const blocker = (
          await sql<{
            unknown: boolean;
            ordinary: boolean;
            invalid: boolean;
          }>`WITH owned AS MATERIALIZED(
            SELECT DISTINCT event.deletion_cancellation_audit_id AS audit_id
              FROM platform.outbox_events event WHERE event.deletion_cancellation_audit_id IS NOT NULL
              AND platform.deletion_event_owned(${scope.userId}::uuid,event)
            UNION SELECT audit.id FROM platform.audit_logs audit
              JOIN identity.account_deletion_records root ON root.id=audit.subject_id
              WHERE audit.event_type='account.deletion-operational-batch.v1' AND root.user_id=${scope.userId}::uuid)
            SELECT
            EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.deletion_cancellation_audit_id IS NULL AND
              platform.deletion_event_disposition(event.event_type,event.schema_version,event.payload)='unclassified') AS unknown,
            EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.deletion_cancellation_audit_id IS NULL AND
              platform.deletion_event_disposition(event.event_type,event.schema_version,event.payload)='ordinary_content'
              AND platform.deletion_event_owned(${scope.userId}::uuid,event)) AS ordinary,
            EXISTS(SELECT 1 FROM owned
              WHERE platform.deletion_cancellation_audit_valid(owned.audit_id) IS NOT TRUE) AS invalid`.execute(
            tx,
          )
        ).rows[0]!;
        if (blocker.unknown || blocker.ordinary || blocker.invalid)
          return {
            cancelledRows: 0,
            hasMore: true,
            waitingForLease: false,
            blockedBy: blocker.unknown
              ? 'unclassified'
              : blocker.ordinary
                ? 'ordinary_content'
                : 'proof_invalid',
          };
        // Outbox claims can lock their rows before entering an Account handler.
        // Never invert that order while this worker owns the deletion fence.
        const sources = (
          await sql<{
            id: string;
            digest: string;
          }>`SELECT event.id,platform.deletion_event_digest(event) AS digest
            FROM platform.outbox_events event WHERE event.deletion_cancellation_audit_id IS NULL
              AND platform.deletion_event_disposition(event.event_type,event.schema_version,event.payload)='product_transport'
              AND platform.deletion_event_owned(${scope.userId}::uuid,event)
              AND (event.lease_expires_at IS NULL OR event.lease_expires_at<=clock_timestamp())
            ORDER BY event.id LIMIT 100 FOR UPDATE SKIP LOCKED`.execute(tx)
        ).rows;
        if (sources.length > 0) {
          const auditId = randomUUID(),
            eventId = randomUUID();
          const hashes = JSON.stringify(
            Object.fromEntries(sources.map((row) => [row.id, row.digest])),
          );
          const proof = (
            await sql<{ at: string }>`WITH facts AS (SELECT root.command_id,root.request_id,
                work.lease_owner,work.lease_generation,work.lease_expires_at,clock_timestamp() AS at
              FROM identity.account_deletion_records root JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
              WHERE root.id=${scope.deletionRecordId}::uuid)
            INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,
              metadata_schema_version,metadata,command_id,request_id,occurred_at)
            SELECT ${auditId}::uuid,'account','account.deletion-operational-batch.v1','system','account_deletion',${scope.deletionRecordId}::uuid,
              'outbox_cancelled',1,jsonb_build_object('kind','outbox_cancel','rows',${sources.length}::integer,
                'sourceHashes',${hashes}::jsonb,'eventId',${eventId}::uuid,'owner',lease_owner,'generation',lease_generation,
                'leaseExpiresAt',lease_expires_at,'transaction',pg_current_xact_id()::text),command_id,request_id,at
            FROM facts RETURNING occurred_at::text AS at`.execute(tx)
          ).rows;
          if (proof.length !== 1) throw Error('Operational cancellation audit missing');
          const updated =
            await sql`UPDATE platform.outbox_events SET deletion_cancellation_audit_id=${auditId}::uuid,
              lease_owner=NULL,lease_expires_at=NULL WHERE id IN(${sql.join(sources.map((row) => sql`${row.id}::uuid`))})
              AND deletion_cancellation_audit_id IS NULL RETURNING id`.execute(tx);
          if (updated.rows.length !== sources.length)
            throw Error('Operational cancellation incomplete');
          const event =
            await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,
              payload,occurred_at,available_at,correlation_id,causation_id)
            SELECT ${eventId}::uuid,'account_deletion',root.id,'account.deletion-operational-batch.v1',1,
              jsonb_build_object('deletionRecordId',root.id,'kind','outbox_cancel','rows',${sources.length}::integer,'auditId',${auditId}::uuid),
              ${proof[0]!.at}::timestamptz,${proof[0]!.at}::timestamptz,root.request_id,root.command_id
            FROM identity.account_deletion_records root WHERE root.id=${scope.deletionRecordId}::uuid RETURNING id`.execute(
              tx,
            );
          if (event.rows.length !== 1) throw Error('Operational cancellation event missing');
        }
        const remaining = (
          await sql<{ remaining: boolean; leased: boolean }>`SELECT
            EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.deletion_cancellation_audit_id IS NULL
              AND platform.deletion_event_disposition(event.event_type,event.schema_version,event.payload)='product_transport'
              AND platform.deletion_event_owned(${scope.userId}::uuid,event)) AS remaining,
            EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.deletion_cancellation_audit_id IS NULL
              AND platform.deletion_event_disposition(event.event_type,event.schema_version,event.payload)='product_transport'
              AND platform.deletion_event_owned(${scope.userId}::uuid,event) AND event.lease_expires_at>clock_timestamp()) AS leased`.execute(
            tx,
          )
        ).rows[0]!;
        return {
          cancelledRows: sources.length,
          hasMore: remaining.remaining,
          waitingForLease: remaining.leased,
          blockedBy: null,
        };
      });
    } catch {
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    }
  }
}
