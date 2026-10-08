import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import type { AccountDeletionLease } from '@nakh/application';
import { ApplicationError, normalizeUserPair } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { insertNotification } from './notification-store.js';

function conflict(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}

/** Include grants on already-closed Likes and chats on already-closed Matches.
 * No text or financial/provider payload is selected. */
function openPairs(userId: string): RawBuilder<{ otherUserId: string }> {
  return sql<{ otherUserId: string }>`
    SELECT receiver_user_id AS "otherUserId" FROM interaction.likes WHERE sender_user_id=${userId}::uuid AND status='active'
    UNION SELECT sender_user_id FROM interaction.likes WHERE receiver_user_id=${userId}::uuid AND status='active'
    UNION SELECT CASE WHEN user_low_id=${userId}::uuid THEN user_high_id ELSE user_low_id END
      FROM matching.matches WHERE (user_low_id=${userId}::uuid OR user_high_id=${userId}::uuid) AND status='active'
    UNION SELECT CASE WHEN match.user_low_id=${userId}::uuid THEN match.user_high_id ELSE match.user_low_id END
      FROM chat.chat_sessions session JOIN matching.matches match ON match.id=session.match_id
      WHERE session.status='active' AND (match.user_low_id=${userId}::uuid OR match.user_high_id=${userId}::uuid)
    UNION SELECT CASE WHEN user_low_id=${userId}::uuid THEN user_high_id ELSE user_low_id END
      FROM interaction.user_pair_states WHERE state='matched' AND (user_low_id=${userId}::uuid OR user_high_id=${userId}::uuid)
    UNION SELECT CASE WHEN like_scope.sender_user_id=${userId}::uuid THEN like_scope.receiver_user_id ELSE like_scope.sender_user_id END
      FROM interaction.feature_unlocks grant_scope JOIN interaction.likes like_scope ON like_scope.id=grant_scope.like_id
      WHERE grant_scope.status='active' AND (like_scope.sender_user_id=${userId}::uuid OR like_scope.receiver_user_id=${userId}::uuid)
    UNION SELECT CASE WHEN match.user_low_id=${userId}::uuid THEN match.user_high_id ELSE match.user_low_id END
      FROM interaction.feature_unlocks grant_scope JOIN matching.matches match ON match.id=grant_scope.match_id
      WHERE grant_scope.status='active' AND (match.user_low_id=${userId}::uuid OR match.user_high_id=${userId}::uuid)
    UNION SELECT CASE WHEN flow.sender_user_id=${userId}::uuid THEN flow.receiver_user_id ELSE flow.sender_user_id END
      FROM nakh.pending_nakhes pending JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
      WHERE pending.status='pending_payment' AND (flow.sender_user_id=${userId}::uuid OR flow.receiver_user_id=${userId}::uuid)
    UNION SELECT CASE WHEN sender_user_id=${userId}::uuid THEN receiver_user_id ELSE sender_user_id END
      FROM nakh.nakhes WHERE status IN ('sent','seen') AND (sender_user_id=${userId}::uuid OR receiver_user_id=${userId}::uuid)
  `;
}
export type DeletionSharedBatch = Readonly<{ examined: 0 | 1; changed: boolean; hasMore: boolean }>;

/** One normalized pair per transaction. Re-scanning still-open facts resumes after a crash.
 * Shared closure preserves Report sources and all financial/provider rows; it never completes purge. */
export class PostgresAccountDeletionSharedStore {
  private readonly work: PostgresAccountDeletionWorkStore;
  public constructor(private readonly database: NakhDatabase) {
    this.work = new PostgresAccountDeletionWorkStore(database);
  }
  private async hasMore(tx: NakhDatabase, userId: string): Promise<boolean> {
    return (
      await sql<{
        open: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM (${openPairs(userId)}) scopes) AS open`.execute(tx)
    ).rows[0]!.open;
  }
  public async closeNext(lease: AccountDeletionLease): Promise<DeletionSharedBatch> {
    if (lease.phase !== 'shared_closure') throw conflict();
    const candidate = await this.work.withLease(
      lease,
      async (tx, scope) =>
        (
          await sql<{
            otherUserId: string;
          }>`SELECT "otherUserId" FROM (${openPairs(scope.userId)}) scopes
      ORDER BY "otherUserId" LIMIT 1`.execute(tx)
        ).rows[0],
    );
    if (candidate === undefined) return { examined: 0, changed: false, hasMore: false };
    return this.work.withPairLease(lease, candidate.otherUserId, async (tx, scope) => {
      const pair = normalizeUserPair(scope.userId, candidate.otherUserId);
      const metadata = (
        await sql<{
          command_id: string;
          request_id: string;
          at: Date;
        }>`SELECT command_id,request_id,clock_timestamp() AS at
        FROM identity.account_deletion_records WHERE id=${scope.deletionRecordId}::uuid`.execute(tx)
      ).rows[0]!;
      const at = metadata.at;
      const pairLikes = sql`SELECT id FROM interaction.likes WHERE
        (sender_user_id=${pair.userLowId}::uuid AND receiver_user_id=${pair.userHighId}::uuid)
        OR (sender_user_id=${pair.userHighId}::uuid AND receiver_user_id=${pair.userLowId}::uuid)`;
      const pairMatches = sql`SELECT id FROM matching.matches WHERE user_low_id=${pair.userLowId}::uuid AND user_high_id=${pair.userHighId}::uuid`;
      const counts = {
        likes: 0,
        matches: 0,
        chats: 0,
        grants: 0,
        pending: 0,
        delivered: 0,
        pairs: 0,
      };
      counts.likes = (
        await sql`UPDATE interaction.likes SET status='cancelled_by_system',closed_at=${at},version=version+1
        WHERE id IN (${pairLikes}) AND status='active' RETURNING id`.execute(tx)
      ).rows.length;
      const matches = await sql<{
        id: string;
      }>`UPDATE matching.matches SET status='closed',closed_at=${at},version=version+1
        WHERE id IN (${pairMatches}) AND status='active' RETURNING id`.execute(tx);
      counts.matches = matches.rows.length;
      const chats = await sql<{
        id: string;
        match_id: string;
      }>`UPDATE chat.chat_sessions SET status='closed',closed_at=${at},closed_reason='account_deleted',version=version+1
        WHERE match_id IN (${pairMatches}) AND status='active' RETURNING id,match_id`.execute(tx);
      counts.chats = chats.rows.length;
      counts.grants = (
        await sql`UPDATE interaction.feature_unlocks SET status='revoked',revoked_at=${at},revoked_reason='account_deleted',version=version+1
        WHERE status='active' AND (like_id IN (${pairLikes}) OR match_id IN (${pairMatches})) RETURNING id`.execute(
          tx,
        )
      ).rows.length;
      counts.pairs = (
        await sql`UPDATE interaction.user_pair_states SET state='unmatched',reason_code='account_deleted',changed_at=${at},version=version+1
        WHERE user_low_id=${pair.userLowId}::uuid AND user_high_id=${pair.userHighId}::uuid AND state='matched' RETURNING user_low_id`.execute(
          tx,
        )
      ).rows.length;
      const pending = (
        await sql<{
          id: string;
          sender_user_id: string;
          pending_payment_id: string;
        }>`SELECT pending.id,pending.sender_user_id,pending.pending_payment_id
        FROM nakh.pending_nakhes pending JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
        WHERE pending.status='pending_payment' AND
          ((flow.sender_user_id=${pair.userLowId}::uuid AND flow.receiver_user_id=${pair.userHighId}::uuid)
          OR (flow.sender_user_id=${pair.userHighId}::uuid AND flow.receiver_user_id=${pair.userLowId}::uuid))
        ORDER BY pending.id FOR UPDATE OF pending`.execute(tx)
      ).rows;
      for (const item of pending) {
        const intent = await tx
          .selectFrom('billing.pending_payments')
          .select('status')
          .where('id', '=', item.pending_payment_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        // Paid fulfillment needs its separate financial closure path. Never turn
        // received money into a cancelled payment or claim verified completion.
        if (!['pending', 'cancelled', 'expired'].includes(intent.status)) throw conflict();
        await sql`UPDATE billing.pending_payments SET status='cancelled',resolved_at=${at},version=version+1
          WHERE id=${item.pending_payment_id}::uuid AND status='pending'`.execute(tx);
        const closed =
          await sql`UPDATE nakh.pending_nakhes SET status='closed_by_system',closed_at=${at},version=version+1
          WHERE id=${item.id}::uuid AND status='pending_payment' RETURNING id`.execute(tx);
        if (closed.rows.length !== 1) throw conflict();
        const counter =
          await sql`UPDATE platform.user_counters SET pending_nakh_count=pending_nakh_count-1,version=version+1,updated_at=${at}
          WHERE user_id=${item.sender_user_id}::uuid AND pending_nakh_count>0 RETURNING user_id`.execute(
            tx,
          );
        if (counter.rows.length !== 1) throw conflict();
        counts.pending++;
      }
      const delivered = (
        await sql<{
          id: string;
          status: 'sent' | 'seen';
          version: number;
        }>`SELECT id,status,version FROM nakh.nakhes
        WHERE status IN ('sent','seen') AND
          ((sender_user_id=${pair.userLowId}::uuid AND receiver_user_id=${pair.userHighId}::uuid)
          OR (sender_user_id=${pair.userHighId}::uuid AND receiver_user_id=${pair.userLowId}::uuid))
        ORDER BY id FOR UPDATE`.execute(tx)
      ).rows;
      for (const item of delivered) {
        const closed =
          await sql`UPDATE nakh.nakhes SET status='closed',closed_at=${at},version=version+1
          WHERE id=${item.id}::uuid AND status=${item.status} AND version=${item.version} RETURNING id`.execute(
            tx,
          );
        if (closed.rows.length !== 1) throw conflict();
        await tx
          .insertInto('nakh.nakh_status_history')
          .values({
            id: randomUUID(),
            nakh_id: item.id,
            nakh_version: item.version + 1,
            from_status: item.status,
            to_status: 'closed',
            reason_code: 'account_deleted',
            changed_by_user_id: null,
            request_id: metadata.request_id,
            changed_at: at,
          })
          .execute();
        counts.delivered++;
      }
      // A suppressed transition or unsupported active scope cannot masquerade as closure.
      if (
        (
          await sql<{
            open: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM (${openPairs(scope.userId)}) scopes
        WHERE "otherUserId"=${candidate.otherUserId}::uuid) AS open`.execute(tx)
        ).rows[0]!.open
      )
        throw conflict();
      const changed = Object.values(counts).some((value) => value > 0);
      if (changed) {
        const closedMatchId = chats.rows[0]?.match_id ?? matches.rows[0]?.id;
        await sql`UPDATE identity.account_deletion_records SET purge_started_at=COALESCE(purge_started_at,${at})
          WHERE id=${scope.deletionRecordId}::uuid`.execute(tx);
        const auditId = randomUUID(),
          eventId = randomUUID();
        const audit = await tx
          .insertInto('platform.audit_logs')
          .values({
            id: auditId,
            category: 'account',
            event_type: 'account.shared-scope-closed.v1',
            actor_type: 'system',
            actor_user_id: null,
            actor_admin_id: null,
            subject_type: 'account_deletion',
            subject_id: scope.deletionRecordId,
            result_code: 'shared_closed',
            metadata_schema_version: 1,
            metadata: { ...counts },
            command_id: metadata.command_id,
            request_id: metadata.request_id,
            occurred_at: at,
          })
          .returning('id')
          .executeTakeFirst();
        if (audit === undefined) throw conflict();
        const event = await tx
          .insertInto('platform.outbox_events')
          .values({
            id: eventId,
            aggregate_type: 'account_deletion',
            aggregate_id: scope.deletionRecordId,
            event_type: 'account.shared-scope-closed.v1',
            schema_version: 1,
            payload: {
              deletionRecordId: scope.deletionRecordId,
              recipientUserId: candidate.otherUserId,
              ...(closedMatchId === undefined ? {} : { matchId: closedMatchId }),
            },
            occurred_at: at,
            available_at: at,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: metadata.request_id,
            causation_id: metadata.command_id,
          })
          .returning('id')
          .executeTakeFirst();
        if (event === undefined) throw conflict();
        const other = await tx
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', candidate.otherUserId)
          .executeTakeFirstOrThrow();
        if (closedMatchId !== undefined && other.state !== 'deleted')
          await insertNotification(tx, {
            userId: candidate.otherUserId,
            type: 'chat_closed',
            titleKey: 'notification.chat_closed.title',
            bodyKey: 'notification.chat_closed.body',
            payload: { matchId: closedMatchId },
            deduplicationKey: `account-deleted:${scope.deletionRecordId}:${closedMatchId}`,
            correlationId: metadata.request_id,
            causationId: metadata.command_id,
          });
      }
      return { examined: 1, changed, hasMore: await this.hasMore(tx, scope.userId) };
    });
  }
}
