import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionPhotoArchiveResult = Readonly<{
  archived: boolean;
  hasMore: boolean;
  waitingForCapture?: true;
}>;
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
/** One owning product photo per lease. Exact holds, objects, assets, variants,
 * moderation history and capture envelopes remain unchanged. No phase completion. */
export class PostgresAccountDeletionPhotoStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  private async hasMore(tx: NakhDatabase, userId: string): Promise<boolean> {
    return (
      await sql<{ remaining: boolean }>`SELECT EXISTS(SELECT 1 FROM media.profile_photos photo
      JOIN profile.profile_reference_anchors profile ON profile.id=photo.profile_id
      WHERE profile.user_id=${userId}::uuid) AS remaining`.execute(tx)
    ).rows[0]!.remaining;
  }
  public async archiveNext(lease: AccountDeletionLease): Promise<DeletionPhotoArchiveResult> {
    if (lease.phase !== 'evidence_capture' || lease.checkpointVersion !== 2) throw conflict();
    try {
      return await this.work.withLease(lease, async (tx, scope) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const photo = (
          await sql<{ id: string }>`SELECT photo.id FROM media.profile_photos photo
          JOIN profile.profile_reference_anchors profile ON profile.id=photo.profile_id
          WHERE profile.user_id=${scope.userId}::uuid ORDER BY photo.id LIMIT 1 FOR UPDATE OF photo`.execute(
            tx,
          )
        ).rows[0];
        if (photo === undefined) return { archived: false, hasMore: false };
        const ready = (
          await sql<{
            ready: boolean;
          }>`SELECT identity.photo_captures_verified(${scope.deletionRecordId}::uuid,${photo.id}::uuid) AS ready`.execute(
            tx,
          )
        ).rows[0]!.ready;
        if (!ready) return { archived: false, hasMore: true, waitingForCapture: true };
        const facts = (
          await sql<{
            command_id: string;
            request_id: string;
            at: string;
          }>`SELECT command_id,request_id,clock_timestamp()::text AS at
          FROM identity.account_deletion_records WHERE id=${scope.deletionRecordId}::uuid`.execute(
            tx,
          )
        ).rows[0]!;
        const auditId = randomUUID(),
          eventId = randomUUID();
        const audit =
          await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,
          result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
          VALUES(${auditId}::uuid,'account','account.deletion-photo-archived.v1','system','account_deletion',${scope.deletionRecordId}::uuid,
            'photo_archived',1,'{"kind":"photo_source"}'::jsonb,${facts.command_id}::uuid,${facts.request_id}::uuid,${facts.at}) RETURNING id`.execute(
            tx,
          );
        const event =
          await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
          occurred_at,available_at,correlation_id,causation_id)
          VALUES(${eventId}::uuid,'account_deletion',${scope.deletionRecordId}::uuid,'account.deletion-photo-archived.v1',1,
            jsonb_build_object('deletionRecordId',${scope.deletionRecordId}::uuid,'kind','photo_source'),${facts.at},${facts.at},
            ${facts.request_id}::uuid,${facts.command_id}::uuid) RETURNING id`.execute(tx);
        const receipt =
          await sql`INSERT INTO identity.account_deletion_photo_receipts(photo_id,deletion_record_id,checklist_version,
          lease_owner,lease_generation,lease_expires_at,archived_at,audit_id,event_id)
          VALUES(${photo.id}::uuid,${scope.deletionRecordId}::uuid,1,${scope.leaseOwner}::uuid,${scope.leaseGeneration},
            (SELECT lease_expires_at FROM identity.account_deletion_work WHERE deletion_record_id=${scope.deletionRecordId}::uuid),
            ${facts.at},${auditId}::uuid,${eventId}::uuid) RETURNING photo_id`.execute(tx);
        const removed = await tx
          .deleteFrom('media.profile_photos')
          .where('id', '=', photo.id)
          .returning('id')
          .execute();
        if (
          audit.rows.length !== 1 ||
          event.rows.length !== 1 ||
          receipt.rows.length !== 1 ||
          removed.length !== 1
        )
          throw conflict();
        return { archived: true, hasMore: await this.hasMore(tx, scope.userId) };
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw conflict();
    }
  }
}
