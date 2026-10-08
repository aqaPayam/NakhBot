import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionProfileArchiveResult = Readonly<{
  archived: boolean;
  waitingForCapture?: true;
}>;
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
/** Removes only the owning product Profile and its cascading product details.
 * Exact two-identifier anchors preserve historical evidence/hold bindings.
 * No retained capture, media object or financial history is released here. */
export class PostgresAccountDeletionProfileStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  public async archive(lease: AccountDeletionLease): Promise<DeletionProfileArchiveResult> {
    if (lease.phase !== 'evidence_capture' || lease.checkpointVersion !== 2) throw conflict();
    try {
      return await this.work.withLease(lease, async (tx, scope) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const profile = (
          await sql<{ id: string }>`SELECT id FROM profile.profiles
          WHERE user_id=${scope.userId}::uuid FOR UPDATE`.execute(tx)
        ).rows[0];
        if (profile === undefined) return { archived: false };
        const ready = (
          await sql<{ ready: boolean }>`SELECT identity.profile_captures_verified(
          ${scope.deletionRecordId}::uuid,${profile.id}::uuid) AS ready`.execute(tx)
        ).rows[0]!.ready;
        if (!ready) return { archived: false, waitingForCapture: true };
        const facts = (
          await sql<{ command_id: string; request_id: string; at: string }>`
          SELECT command_id,request_id,clock_timestamp()::text AS at FROM identity.account_deletion_records
          WHERE id=${scope.deletionRecordId}::uuid`.execute(tx)
        ).rows[0]!;
        const auditId = randomUUID(),
          eventId = randomUUID();
        const audit =
          await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,
          result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
          VALUES(${auditId}::uuid,'account','account.deletion-profile-archived.v1','system','account_deletion',
            ${scope.deletionRecordId}::uuid,'profile_archived',1,'{"kind":"profile_source"}'::jsonb,
            ${facts.command_id}::uuid,${facts.request_id}::uuid,${facts.at}) RETURNING id`.execute(
            tx,
          );
        const event =
          await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,
          payload,occurred_at,available_at,correlation_id,causation_id)
          VALUES(${eventId}::uuid,'account_deletion',${scope.deletionRecordId}::uuid,'account.deletion-profile-archived.v1',1,
            jsonb_build_object('deletionRecordId',${scope.deletionRecordId}::uuid,'kind','profile_source'),${facts.at},${facts.at},
            ${facts.request_id}::uuid,${facts.command_id}::uuid) RETURNING id`.execute(tx);
        const receipt =
          await sql`INSERT INTO identity.account_deletion_profile_receipts(deletion_record_id,profile_id,
          checklist_version,lease_owner,lease_generation,lease_expires_at,archived_at,audit_id,event_id)
          VALUES(${scope.deletionRecordId}::uuid,${profile.id}::uuid,1,${scope.leaseOwner}::uuid,${scope.leaseGeneration},
            (SELECT lease_expires_at FROM identity.account_deletion_work WHERE deletion_record_id=${scope.deletionRecordId}::uuid),
            ${facts.at},${auditId}::uuid,${eventId}::uuid) RETURNING profile_id`.execute(tx);
        const removed = await sql`DELETE FROM profile.profiles WHERE id=${profile.id}::uuid
          AND user_id=${scope.userId}::uuid RETURNING id`.execute(tx);
        if (
          audit.rows.length !== 1 ||
          event.rows.length !== 1 ||
          receipt.rows.length !== 1 ||
          removed.rows.length !== 1
        )
          throw conflict();
        return { archived: true };
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw conflict();
    }
  }
}
