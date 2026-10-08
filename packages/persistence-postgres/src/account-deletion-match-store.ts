import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionMatchArchiveResult = Readonly<{
  archived: boolean;
  hasMore: boolean;
  waitingForCapture?: true;
}>;
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
/** One closed Match per pair-ordered lease transaction. No grants, money,
 * immutable Unmatch facts or captures are removed. No phase completion. */
export class PostgresAccountDeletionMatchStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(private readonly database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  private async hasMore(tx: NakhDatabase, userId: string): Promise<boolean> {
    return (
      await sql<{ remaining: boolean }>`SELECT EXISTS(SELECT 1 FROM matching.matches
      WHERE ${userId}::uuid IN (user_low_id,user_high_id)) AS remaining`.execute(tx)
    ).rows[0]!.remaining;
  }
  public async archiveNext(lease: AccountDeletionLease): Promise<DeletionMatchArchiveResult> {
    if (lease.phase !== 'evidence_capture' || lease.checkpointVersion !== 2) throw conflict();
    try {
      const candidate = (
        await sql<{ id: string; other_user_id: string }>`SELECT id,
        CASE WHEN user_low_id=${lease.userId}::uuid THEN user_high_id ELSE user_low_id END AS other_user_id
        FROM matching.matches WHERE ${lease.userId}::uuid IN (user_low_id,user_high_id) ORDER BY id LIMIT 1`.execute(
          this.database,
        )
      ).rows[0];
      if (candidate === undefined)
        return await this.work.withLease(lease, async (tx) => {
          assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
          return { archived: false, hasMore: await this.hasMore(tx, lease.userId) };
        });
      return await this.work.withPairLease(lease, candidate.other_user_id, async (tx, scope) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const source = (
          await sql<{ id: string; status: string }>`SELECT id,status FROM matching.matches
          WHERE id=${candidate.id}::uuid AND ${scope.userId}::uuid IN (user_low_id,user_high_id)
            AND ${candidate.other_user_id}::uuid IN (user_low_id,user_high_id) FOR UPDATE`.execute(
            tx,
          )
        ).rows[0];
        if (source === undefined)
          return { archived: false, hasMore: await this.hasMore(tx, scope.userId) };
        if (source.status === 'active') throw conflict();
        const ready = (
          await sql<{
            ready: boolean;
          }>`SELECT identity.match_captures_verified(${scope.deletionRecordId}::uuid,${source.id}::uuid) AS ready`.execute(
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
          VALUES(${auditId}::uuid,'account','account.deletion-match-archived.v1','system','account_deletion',${scope.deletionRecordId}::uuid,
            'match_archived',1,'{"kind":"match_source"}'::jsonb,${facts.command_id}::uuid,${facts.request_id}::uuid,${facts.at}) RETURNING id`.execute(
            tx,
          );
        const event =
          await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
          occurred_at,available_at,correlation_id,causation_id)
          VALUES(${eventId}::uuid,'account_deletion',${scope.deletionRecordId}::uuid,'account.deletion-match-archived.v1',1,
            jsonb_build_object('deletionRecordId',${scope.deletionRecordId}::uuid,'kind','match_source'),${facts.at},${facts.at},
            ${facts.request_id}::uuid,${facts.command_id}::uuid) RETURNING id`.execute(tx);
        const receipt =
          await sql`INSERT INTO identity.account_deletion_match_receipts(match_id,deletion_record_id,status,closed_at,
          source,source_nakh_id,checklist_version,lease_owner,lease_generation,lease_expires_at,archived_at,audit_id,event_id)
          SELECT id,${scope.deletionRecordId}::uuid,status,closed_at,source,source_nakh_id,1,${scope.leaseOwner}::uuid,${scope.leaseGeneration},
            (SELECT lease_expires_at FROM identity.account_deletion_work WHERE deletion_record_id=${scope.deletionRecordId}::uuid),
            ${facts.at},${auditId}::uuid,${eventId}::uuid FROM matching.matches WHERE id=${source.id}::uuid RETURNING match_id`.execute(
            tx,
          );
        await tx
          .deleteFrom('matching.match_participants')
          .where('match_id', '=', source.id)
          .execute();
        const removed = await tx
          .deleteFrom('matching.matches')
          .where('id', '=', source.id)
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
