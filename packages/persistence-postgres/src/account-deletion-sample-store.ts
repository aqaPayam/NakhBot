import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type SampleDeletionBatch = Readonly<{
  purgedEffects: number;
  purgedProjections: number;
  purgedEvents: number;
  hasMore: boolean;
  waitingForLease: boolean;
}>;
const empty = { purgedEffects: 0, purgedProjections: 0, purgedEvents: 0 };
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}

/** Removes one original synthetic source and up to 100 event copies per call.
 * No retained financial/safety event is removed. Born scope remains for queues. */
export class PostgresAccountDeletionSampleStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  public async purgeNext(lease: AccountDeletionLease): Promise<SampleDeletionBatch> {
    if (lease.phase !== 'product_data' || lease.checkpointVersion !== 3) throw conflict();
    try {
      return await this.work.withLease(lease, async (tx, scope) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const root = (
          await sql<{ product_epoch: number; command_id: string; request_id: string }>`
            SELECT product_epoch,command_id,request_id FROM identity.account_deletion_records
            WHERE id=${scope.deletionRecordId}::uuid`.execute(tx)
        ).rows[0]!;
        const invalid = (
          await sql<{ invalid: boolean }>`SELECT
          EXISTS(SELECT 1 FROM platform.sample_effects source LEFT JOIN platform.sample_reference_anchors original ON original.id=source.id
            WHERE source.actor_user_id=${scope.userId}::uuid AND (original.id IS NULL OR original.actor_user_id<>source.actor_user_id
              OR original.product_epoch IS DISTINCT FROM ${root.product_epoch} OR original.name_digest<>encode(sha256(convert_to(source.name,'UTF8')),'hex')))
          OR EXISTS(SELECT 1 FROM platform.sample_reference_anchors original WHERE original.actor_user_id=${scope.userId}::uuid
            AND original.product_epoch=${root.product_epoch} AND EXISTS(SELECT 1 FROM platform.sample_effects source
              WHERE source.id=original.id AND (source.actor_user_id<>original.actor_user_id
                OR original.name_digest<>encode(sha256(convert_to(source.name,'UTF8')),'hex'))))
          OR EXISTS(SELECT 1 FROM platform.sample_reference_anchors original WHERE original.actor_user_id=${scope.userId}::uuid
            AND original.product_epoch=${root.product_epoch} AND NOT EXISTS(SELECT 1 FROM platform.sample_effects WHERE id=original.id)
            AND platform.sample_purge_proven(${scope.deletionRecordId}::uuid,original.id) IS NOT TRUE) AS invalid`.execute(
            tx,
          )
        ).rows[0]!.invalid;
        if (invalid) throw conflict();
        const source = (
          await sql<{ id: string; digest: string }>`SELECT source.id,original.name_digest AS digest
          FROM platform.sample_effects source JOIN platform.sample_reference_anchors original ON original.id=source.id
          WHERE source.actor_user_id=${scope.userId}::uuid AND original.product_epoch=${root.product_epoch}
          ORDER BY source.id LIMIT 1 FOR UPDATE OF source SKIP LOCKED`.execute(tx)
        ).rows[0];
        if (source === undefined) {
          const remains = await tx
            .selectFrom('platform.sample_effects')
            .select('id')
            .where('actor_user_id', '=', scope.userId)
            .limit(1)
            .executeTakeFirst();
          return {
            ...empty,
            hasMore: remains !== undefined,
            waitingForLease: remains !== undefined,
          };
        }
        const events = (
          await sql<{ id: string; valid: boolean; leased: boolean }>`SELECT id,
          event_type='platform.sample-effect-created.v1' AND schema_version=1
          AND payload=jsonb_build_object('effectId',${source.id}::uuid,'name',(SELECT name FROM platform.sample_effects WHERE id=${source.id}::uuid)) AS valid,
          lease_expires_at>clock_timestamp() AS leased
          FROM platform.outbox_events WHERE aggregate_type='sample_effect' AND aggregate_id=${source.id}::uuid
          ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`.execute(tx)
        ).rows;
        if (events.some((event) => !event.valid)) throw conflict();
        if (events.some((event) => event.leased))
          return { ...empty, hasMore: true, waitingForLease: true };
        let purgedEvents = 0;
        if (events.length > 0) {
          const deleted = await tx
            .deleteFrom('platform.outbox_events')
            .where(
              'id',
              'in',
              events.map((event) => event.id),
            )
            .returning('id')
            .execute();
          if (deleted.length !== events.length) throw conflict();
          purgedEvents = deleted.length;
        }
        const left = await tx
          .selectFrom('platform.outbox_events')
          .select('id')
          .where('aggregate_type', '=', 'sample_effect')
          .where('aggregate_id', '=', source.id)
          .limit(1)
          .executeTakeFirst();
        let purgedEffects = 0,
          purgedProjections = 0;
        if (left === undefined) {
          purgedProjections = (
            await tx
              .deleteFrom('platform.sample_projections')
              .where('effect_id', '=', source.id)
              .returning('id')
              .execute()
          ).length;
          purgedEffects = (
            await tx
              .deleteFrom('platform.sample_effects')
              .where('id', '=', source.id)
              .returning('id')
              .execute()
          ).length;
          if (purgedEffects !== 1 || purgedProjections > 1) throw conflict();
        } else if (purgedEvents === 0) return { ...empty, hasMore: true, waitingForLease: true };
        const auditId = randomUUID(),
          eventId = randomUUID();
        const hashes = JSON.stringify({ [source.id]: source.digest });
        const proof = (
          await sql<{
            at: string;
          }>`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,
          result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
          SELECT ${auditId}::uuid,'account','account.deletion-product-batch.v1','system','account_deletion',${scope.deletionRecordId}::uuid,
            'product_batch_purged',1,jsonb_build_object('resource',11,'rows',1,'eventId',${eventId}::uuid,
              'owner',work.lease_owner,'generation',work.lease_generation,'leaseExpiresAt',work.lease_expires_at,
              'sourceHashes',${hashes}::jsonb,'final',${purgedEffects === 1}::boolean,'deletedCount',${purgedEvents + purgedEffects + purgedProjections}::integer),
            ${root.command_id}::uuid,${root.request_id}::uuid,clock_timestamp()
          FROM identity.account_deletion_work work WHERE deletion_record_id=${scope.deletionRecordId}::uuid
          RETURNING occurred_at::text AS at`.execute(tx)
        ).rows;
        if (proof.length !== 1) throw conflict();
        const outbox = await tx
          .insertInto('platform.outbox_events')
          .values({
            id: eventId,
            aggregate_type: 'account_deletion',
            aggregate_id: scope.deletionRecordId,
            event_type: 'account.deletion-product-batch.v1',
            schema_version: 1,
            payload: { deletionRecordId: scope.deletionRecordId, resource: 11, rows: 1, auditId },
            occurred_at: new Date(proof[0]!.at),
            available_at: new Date(proof[0]!.at),
            correlation_id: root.request_id,
            causation_id: root.command_id,
          })
          .returning('id')
          .execute();
        if (outbox.length !== 1) throw conflict();
        // Preserve native microseconds in the mandatory audit/event chain.
        await sql`UPDATE platform.outbox_events SET occurred_at=${proof[0]!.at}::timestamptz,available_at=${proof[0]!.at}::timestamptz WHERE id=${eventId}::uuid`.execute(
          tx,
        );
        if (purgedEffects === 1) {
          const receipt =
            await sql`INSERT INTO identity.account_deletion_sample_receipts(source_id,deletion_record_id,audit_id,event_id,proof_hash)
            VALUES(${source.id}::uuid,${scope.deletionRecordId}::uuid,${auditId}::uuid,${eventId}::uuid,
              platform.sample_purge_digest(${auditId}::uuid,${eventId}::uuid)) RETURNING source_id`.execute(
              tx,
            );
          if (receipt.rows.length !== 1) throw conflict();
        }
        const remains = await tx
          .selectFrom('platform.sample_effects')
          .select('id')
          .where('actor_user_id', '=', scope.userId)
          .limit(1)
          .executeTakeFirst();
        return {
          purgedEffects,
          purgedProjections,
          purgedEvents,
          hasMore: remains !== undefined,
          waitingForLease: false,
        };
      });
    } catch {
      throw conflict();
    }
  }
}
