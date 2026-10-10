import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';

export type DeletionSupportClosureResult = Readonly<{ closed: boolean; hasMore: boolean }>;
/** One retained support scope per transaction. Never deletes messages, advances
 * deletion phases, grants return or approves a retained-data release. */
export class PostgresAccountDeletionSupportStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  public async closeNext(lease: AccountDeletionLease): Promise<DeletionSupportClosureResult> {
    if (lease.phase !== 'product_data' || lease.checkpointVersion !== 3)
      throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
    return this.work.withLease(lease, async (tx, scope) => {
      const source = (
        await sql<{ id: string }>`SELECT thread.id FROM support.support_threads thread
        JOIN identity.account_deletion_records root ON root.id=${scope.deletionRecordId}::uuid
        WHERE thread.user_id=root.user_id AND thread.product_epoch=root.product_epoch AND thread.status='open'
        ORDER BY thread.id LIMIT 1 FOR UPDATE OF thread`.execute(tx)
      ).rows[0];
      if (source === undefined) return { closed: false, hasMore: false };
      const audit = randomUUID(),
        event = randomUUID();
      // Source metadata and exact database lease expiry are copied inside SQL;
      // they never lose microseconds through a JavaScript Date round-trip.
      const at = (
        await sql<{ at: Date }>`SELECT date_trunc('milliseconds',clock_timestamp()) AS at`.execute(
          tx,
        )
      ).rows[0]!.at;
      await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,
        metadata_schema_version,metadata,command_id,request_id,occurred_at)
        SELECT ${audit}::uuid,'account','account.deletion-support-closed.v1','system','account_deletion',root.id,
          'support_scope_closed',1,'{"kind":"support_scope","count":1}'::jsonb,root.command_id,root.request_id,${at}
        FROM identity.account_deletion_records root WHERE root.id=${scope.deletionRecordId}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
        causation_id,correlation_id,occurred_at,available_at)
        SELECT ${event}::uuid,'account_deletion',root.id,'account.deletion-support-closed.v1',1,
          jsonb_build_object('deletionRecordId',root.id,'kind','support_scope','count',1),root.command_id,root.request_id,${at},${at}
        FROM identity.account_deletion_records root WHERE root.id=${scope.deletionRecordId}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO support.deletion_thread_closures(support_thread_id,deletion_record_id,user_id,product_epoch,
        source_version,source_last_message_at,source_created_at,source_open_command_id,source_open_request_digest,
        lease_owner,lease_generation,lease_expires_at,closed_at,audit_id,event_id)
        SELECT thread.id,root.id,root.user_id,root.product_epoch,thread.version,thread.last_message_at,thread.created_at,
          thread.open_command_id,thread.open_request_digest,work.lease_owner,work.lease_generation,work.lease_expires_at,
          ${at},${audit}::uuid,${event}::uuid
        FROM support.support_threads thread JOIN identity.account_deletion_records root ON root.id=${scope.deletionRecordId}::uuid
        JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id WHERE thread.id=${source.id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE support.support_threads SET status='closed',version=version+1,closed_at=${at}
        WHERE id=${source.id}::uuid`.execute(tx);
      const hasMore = (
        await sql<{ present: boolean }>`SELECT EXISTS(SELECT 1 FROM support.support_threads thread
        JOIN identity.account_deletion_records root ON root.id=${scope.deletionRecordId}::uuid
        WHERE thread.user_id=root.user_id AND thread.product_epoch=root.product_epoch AND thread.status='open') AS present`.execute(
          tx,
        )
      ).rows[0]!.present;
      return { closed: true, hasMore };
    });
  }
}
