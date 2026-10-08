import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

export type DeletionChatArchiveResult = Readonly<{
  deletedMessages: number;
  archived: boolean;
  hasMore: boolean;
  waitingForCapture?: true;
}>;
function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}
/** One closed Chat, at most 500 oldest messages per fenced pair transaction.
 * Retained captures/markers and Unmatch history remain exact. No provider calls,
 * plaintext result, phase completion or fresh-return authority. */
export class PostgresAccountDeletionChatStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(private readonly database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  private async hasMore(tx: NakhDatabase, userId: string): Promise<boolean> {
    return (
      await sql<{ remaining: boolean }>`SELECT EXISTS(SELECT 1 FROM chat.chat_sessions session
      JOIN matching.matches relationship ON relationship.id=session.match_id
      WHERE ${userId}::uuid IN (relationship.user_low_id,relationship.user_high_id)) AS remaining`.execute(
        tx,
      )
    ).rows[0]!.remaining;
  }
  public async archiveNext(lease: AccountDeletionLease): Promise<DeletionChatArchiveResult> {
    if (lease.phase !== 'evidence_capture' || lease.checkpointVersion !== 2) throw conflict();
    try {
      const candidate = (
        await sql<{ id: string; other_user_id: string }>`SELECT session.id,
        CASE WHEN relationship.user_low_id=${lease.userId}::uuid THEN relationship.user_high_id ELSE relationship.user_low_id END AS other_user_id
        FROM chat.chat_sessions session JOIN matching.matches relationship ON relationship.id=session.match_id
        WHERE ${lease.userId}::uuid IN (relationship.user_low_id,relationship.user_high_id)
        ORDER BY session.id LIMIT 1`.execute(this.database)
      ).rows[0];
      if (candidate === undefined)
        return await this.work.withLease(lease, async (tx) => {
          assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
          return {
            deletedMessages: 0,
            archived: false,
            hasMore: await this.hasMore(tx, lease.userId),
          };
        });
      return await this.work.withPairLease(lease, candidate.other_user_id, async (tx, scope) => {
        assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
        const source = (
          await sql<{
            id: string;
            status: string;
            relationship_status: string;
          }>`SELECT session.id,session.status,relationship.status AS relationship_status
          FROM chat.chat_sessions session JOIN matching.matches relationship ON relationship.id=session.match_id
          WHERE session.id=${candidate.id}::uuid
            AND ${scope.userId}::uuid IN (relationship.user_low_id,relationship.user_high_id)
            AND ${candidate.other_user_id}::uuid IN (relationship.user_low_id,relationship.user_high_id)
          FOR UPDATE OF relationship,session`.execute(tx)
        ).rows[0];
        if (source === undefined)
          return {
            deletedMessages: 0,
            archived: false,
            hasMore: await this.hasMore(tx, scope.userId),
          };
        if (source.status !== 'closed' || source.relationship_status === 'active') throw conflict();
        const ready = (
          await sql<{
            ready: boolean;
          }>`SELECT identity.chat_captures_verified(${scope.deletionRecordId}::uuid,${source.id}::uuid) AS ready`.execute(
            tx,
          )
        ).rows[0]!.ready;
        if (!ready)
          return { deletedMessages: 0, archived: false, hasMore: true, waitingForCapture: true };
        const messages = (
          await sql<{
            id: string;
          }>`SELECT id FROM chat.chat_messages WHERE chat_session_id=${source.id}::uuid
          ORDER BY sequence_number,id LIMIT 501 FOR UPDATE`.execute(tx)
        ).rows;
        const ids = messages.slice(0, 500).map((message) => message.id),
          final = messages.length <= 500;
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
          VALUES(${auditId}::uuid,'account','account.deletion-chat-archived.v1','system','account_deletion',${scope.deletionRecordId}::uuid,
            'chat_archived',1,jsonb_build_object('kind','chat_source','final',${final}::boolean,'deletedCount',${ids.length}::integer),
            ${facts.command_id}::uuid,${facts.request_id}::uuid,${facts.at}) RETURNING id`.execute(
            tx,
          );
        const event =
          await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
          occurred_at,available_at,correlation_id,causation_id)
          VALUES(${eventId}::uuid,'account_deletion',${scope.deletionRecordId}::uuid,'account.deletion-chat-archived.v1',1,
            jsonb_build_object('deletionRecordId',${scope.deletionRecordId}::uuid,'kind','chat_source','final',${final}::boolean,'deletedCount',${ids.length}::integer),
            ${facts.at},${facts.at},${facts.request_id}::uuid,${facts.command_id}::uuid) RETURNING id`.execute(
            tx,
          );
        const receipt =
          await sql`INSERT INTO identity.account_deletion_chat_receipts(id,deletion_record_id,chat_session_id,original_message_ids,
          final_batch,closed_at,closed_reason,checklist_version,lease_owner,lease_generation,lease_expires_at,archived_at,audit_id,event_id)
          SELECT ${randomUUID()}::uuid,${scope.deletionRecordId}::uuid,session.id,${ids}::uuid[],${final}::boolean,session.closed_at,session.closed_reason,
            1,${scope.leaseOwner}::uuid,${scope.leaseGeneration},
            (SELECT lease_expires_at FROM identity.account_deletion_work WHERE deletion_record_id=${scope.deletionRecordId}::uuid),
            ${facts.at},${auditId}::uuid,${eventId}::uuid FROM chat.chat_sessions session WHERE session.id=${source.id}::uuid RETURNING id`.execute(
            tx,
          );
        const removed =
          await sql`DELETE FROM chat.chat_messages WHERE chat_session_id=${source.id}::uuid AND id=ANY(${ids}::uuid[]) RETURNING id`.execute(
            tx,
          );
        if (
          audit.rows.length !== 1 ||
          event.rows.length !== 1 ||
          receipt.rows.length !== 1 ||
          removed.rows.length !== ids.length
        )
          throw conflict();
        if (final) {
          await tx
            .deleteFrom('chat.chat_participants')
            .where('chat_session_id', '=', source.id)
            .execute();
          await tx
            .deleteFrom('chat.chat_cleanup_checkpoints')
            .where('chat_session_id', '=', source.id)
            .execute();
          if (
            (
              await tx
                .deleteFrom('chat.chat_sessions')
                .where('id', '=', source.id)
                .returning('id')
                .execute()
            ).length !== 1
          )
            throw conflict();
        }
        return {
          deletedMessages: ids.length,
          archived: final,
          hasMore: await this.hasMore(tx, scope.userId),
        };
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw conflict();
    }
  }
}
