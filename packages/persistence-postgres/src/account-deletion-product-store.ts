import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import {
  DELETION_REGISTRY,
  assertDeletionCatalogCoverage,
  readDeletionCatalog,
  type DeletionRegistryEntry,
} from './deletion-registry.js';

// Append-only resource numbers are also validated by migration 96. Filter
// genders and their required parent are one resource. The final selection and
// parent are removed together; earlier chunks always leave a required selection.
const RESOURCES = [
  'identity.signup_drafts',
  'identity.signup_progress',
  'discovery.explore_filters',
  'discovery.candidate_deliveries',
  'discovery.explore_consumptions',
  'interaction.not_interested',
  'notification.notification_preferences',
  'identity.user_settings',
] as const;
const BATCH_LIMIT = 100;
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
function entry(table: string): DeletionRegistryEntry {
  const resource = DELETION_REGISTRY.find((item) => item.table === table);
  if (
    resource === undefined ||
    resource.subjectScope === null ||
    !['ordinary_owned', 'ordinary_shared'].includes(resource.classification)
  )
    throw conflict();
  return resource;
}
function predicate(resource: DeletionRegistryEntry, userId: string): RawBuilder<unknown> {
  return sql.join(
    resource.subjectScope!.split(':userId').map((part) => sql.raw(part)),
    sql`${userId}::uuid`,
  );
}
export type DeletionProductBatchResult = Readonly<{
  purgedRows: number;
  /** Remaining rows in these eight resources only; never whole-purge completion. */
  hasMore: boolean;
}>;

/** Internal phase-3 executor. No policy release, provider I/O, financial reset,
 * phase advance, completion or return authority is produced by this sweep. */
export class PostgresAccountDeletionProductStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  private async present(
    tx: NakhDatabase,
    resource: DeletionRegistryEntry,
    userId: string,
  ): Promise<boolean> {
    return (
      await sql<{
        present: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM ${sql.table(resource.table)} AS row
        WHERE ${predicate(resource, userId)} LIMIT 1) AS present`.execute(tx)
    ).rows[0]!.present;
  }
  public async purgeNext(lease: AccountDeletionLease): Promise<DeletionProductBatchResult> {
    if (lease.phase !== 'product_data' || lease.checkpointVersion !== 3) throw conflict();
    try {
      return await this.work.withLease(lease, async (tx, scope) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const resources = RESOURCES.map(entry);
        let resourceIndex = -1;
        for (let index = 0; index < resources.length; index++) {
          if (await this.present(tx, resources[index]!, scope.userId)) {
            resourceIndex = index;
            break;
          }
        }
        if (resourceIndex === -1) return { purgedRows: 0, hasMore: false };
        const resource = resources[resourceIndex]!;
        let purgedRows: number;
        if (resource.table === 'discovery.explore_filters') {
          const filter = await tx
            .selectFrom('discovery.explore_filters')
            .select('user_id')
            .where('user_id', '=', scope.userId)
            .forUpdate()
            .execute();
          if (filter.length !== 1) throw conflict();
          const children = await tx
            .selectFrom('discovery.explore_filter_genders')
            .select('gender_option_id')
            .where('user_id', '=', scope.userId)
            .orderBy('gender_option_id')
            .limit(BATCH_LIMIT)
            .execute();
          const finalBatch = children.length < BATCH_LIMIT;
          const selected = finalBatch ? children : children.slice(0, BATCH_LIMIT - 1);
          const removed = await tx
            .deleteFrom('discovery.explore_filter_genders')
            .where('user_id', '=', scope.userId)
            .where(
              'gender_option_id',
              'in',
              selected.map((child) => child.gender_option_id),
            )
            .returning('gender_option_id')
            .execute();
          if (removed.length !== selected.length) throw conflict();
          purgedRows = removed.length;
          if (finalBatch) {
            const parent = await tx
              .deleteFrom('discovery.explore_filters')
              .where('user_id', '=', scope.userId)
              .returning('user_id')
              .execute();
            if (parent.length !== 1) throw conflict();
            purgedRows += parent.length;
          }
        } else {
          // ctid exists only inside this statement. It is never persisted or used
          // as a cross-transaction cursor; committed absence makes retries safe.
          const removed = await sql`WITH doomed AS MATERIALIZED (
            SELECT row.ctid FROM ${sql.table(resource.table)} AS row
            WHERE ${predicate(resource, scope.userId)} ORDER BY row.ctid LIMIT ${BATCH_LIMIT} FOR UPDATE
          ) DELETE FROM ${sql.table(resource.table)} AS row USING doomed
            WHERE row.ctid=doomed.ctid RETURNING 1`.execute(tx);
          purgedRows = removed.rows.length;
        }
        if (purgedRows < 1 || purgedRows > BATCH_LIMIT) throw conflict();
        const auditId = randomUUID(),
          eventId = randomUUID();
        const facts = (
          await sql<{ command_id: string; request_id: string; at: string }>`
            SELECT command_id,request_id,clock_timestamp()::text AS at
            FROM identity.account_deletion_records WHERE id=${scope.deletionRecordId}::uuid`.execute(
            tx,
          )
        ).rows[0]!;
        const audit = await sql<{
          id: string;
          event_type: string;
        }>`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,
          result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
          VALUES(${auditId}::uuid,'account','account.deletion-product-batch.v1','system','account_deletion',${scope.deletionRecordId}::uuid,
            'product_batch_purged',1,jsonb_build_object('resource',${resourceIndex}::integer,'rows',${purgedRows}::integer,
              'eventId',${eventId}::uuid,'owner',${scope.leaseOwner}::uuid,'generation',${scope.leaseGeneration}::integer,
              'leaseExpiresAt',(SELECT lease_expires_at FROM identity.account_deletion_work WHERE deletion_record_id=${scope.deletionRecordId}::uuid)),
            ${facts.command_id}::uuid,${facts.request_id}::uuid,${facts.at}) RETURNING id,event_type`.execute(
          tx,
        );
        const event = await sql<{
          id: string;
          event_type: string;
        }>`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
          occurred_at,available_at,correlation_id,causation_id)
          VALUES(${eventId}::uuid,'account_deletion',${scope.deletionRecordId}::uuid,'account.deletion-product-batch.v1',1,
            jsonb_build_object('deletionRecordId',${scope.deletionRecordId}::uuid,'resource',${resourceIndex}::integer,
              'rows',${purgedRows}::integer,'auditId',${auditId}::uuid),${facts.at},${facts.at},${facts.request_id}::uuid,${facts.command_id}::uuid)
          RETURNING id,event_type`.execute(tx);
        if (
          audit.rows.length !== 1 ||
          event.rows.length !== 1 ||
          audit.rows[0]?.id !== auditId ||
          event.rows[0]?.id !== eventId ||
          audit.rows[0]?.event_type !== 'account.deletion-product-batch.v1' ||
          event.rows[0]?.event_type !== 'account.deletion-product-batch.v1'
        )
          throw conflict();
        let hasMore = false;
        for (const item of resources) {
          if (await this.present(tx, item, scope.userId)) {
            hasMore = true;
            break;
          }
        }
        return { purgedRows, hasMore };
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw conflict();
    }
  }
}
