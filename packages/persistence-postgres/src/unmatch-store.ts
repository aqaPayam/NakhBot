import { sql } from 'kysely';

import type { UnmatchStore, UnmatchWrite } from '@nakh/application';
import type { UnmatchResult } from '@nakh/contracts';
import { ApplicationError, unmatchReportWindowExpiresAt } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { insertNotification } from './notification-store.js';
import { lockUserPair } from './pair-lock.js';

function unavailable(): never {
  throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
}

async function databaseTime(database: NakhDatabase): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(database);
  return result.rows[0]!.now;
}

function result(
  row: Readonly<{
    match_id: string;
    unmatched_at: Date;
    report_window_expires_at: Date;
  }>,
  replayed: boolean,
): UnmatchResult {
  return {
    matchId: row.match_id,
    status: 'unmatched',
    unmatchedAt: row.unmatched_at.toISOString(),
    reportWindowExpiresAt: row.report_window_expires_at.toISOString(),
    replayed,
  };
}

export class PostgresUnmatchStore implements UnmatchStore {
  public constructor(private readonly database: NakhDatabase) {}

  public unmatch(write: UnmatchWrite): Promise<UnmatchResult> {
    if (write.command.actor.kind !== 'user')
      return Promise.reject(
        new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401),
      );
    return this.database.transaction().execute(async (transaction) => {
      const identity = await transaction
        .selectFrom('matching.matches')
        .select(['user_low_id', 'user_high_id'])
        .where('id', '=', write.matchId)
        .executeTakeFirst();
      const actorUserId = write.command.actor.userId;
      if (
        identity === undefined ||
        (identity.user_low_id !== actorUserId && identity.user_high_id !== actorUserId)
      )
        unavailable();
      const accounts = await transaction
        .selectFrom('identity.accounts')
        .select(['user_id', 'state'])
        .where('user_id', 'in', [identity.user_low_id, identity.user_high_id])
        .orderBy('user_id')
        .forUpdate()
        .execute();
      const actor = accounts.find(({ user_id }) => user_id === actorUserId);
      if (actor?.state !== 'active' && actor?.state !== 'restricted') unavailable();

      await lockUserPair(transaction, identity.user_low_id, identity.user_high_id);
      const match = await transaction
        .selectFrom('matching.matches as match')
        .innerJoin('interaction.user_pair_states as pair', (join) =>
          join
            .onRef('pair.user_low_id', '=', 'match.user_low_id')
            .onRef('pair.user_high_id', '=', 'match.user_high_id'),
        )
        .select([
          'match.status',
          'match.version as matchVersion',
          'pair.state',
          'pair.version as pairVersion',
        ])
        .where('match.id', '=', write.matchId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const session = await transaction
        .selectFrom('chat.chat_sessions')
        .select(['id', 'status', 'version'])
        .where('match_id', '=', write.matchId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const existing = await transaction
        .selectFrom('matching.unmatch_records')
        .select(['match_id', 'unmatched_at', 'report_window_expires_at'])
        .where('match_id', '=', write.matchId)
        .executeTakeFirst();
      if (existing !== undefined) return result(existing, true);
      if (match.status !== 'active' || match.state !== 'matched' || session.status !== 'active')
        unavailable();

      const unmatchedAt = await databaseTime(transaction);
      const reportWindowExpiresAt = unmatchReportWindowExpiresAt(unmatchedAt);
      await transaction
        .insertInto('matching.unmatch_records')
        .values({
          match_id: write.matchId,
          actor_user_id: actorUserId,
          reason_code: write.command.data.reasonCode ?? null,
          command_id: write.command.commandId,
          idempotency_key: write.command.idempotencyKey,
          unmatched_at: unmatchedAt,
          report_window_expires_at: reportWindowExpiresAt,
        })
        .execute();
      await transaction
        .updateTable('matching.matches')
        .set({ status: 'unmatched', closed_at: unmatchedAt, version: match.matchVersion + 1 })
        .where('id', '=', write.matchId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('interaction.user_pair_states')
        .set({
          state: 'unmatched',
          reason_code: 'unmatch',
          changed_at: unmatchedAt,
          version: match.pairVersion + 1,
        })
        .where('user_low_id', '=', identity.user_low_id)
        .where('user_high_id', '=', identity.user_high_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('chat.chat_sessions')
        .set({
          status: 'closed',
          closed_at: unmatchedAt,
          closed_reason: 'unmatch',
          version: session.version + 1,
        })
        .where('id', '=', session.id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('interaction.likes')
        .set((expression) => ({
          status: 'closed_by_unmatch',
          closed_at: unmatchedAt,
          version: expression('version', '+', 1),
        }))
        .where((expression) =>
          expression.or([
            expression.and([
              expression('sender_user_id', '=', identity.user_low_id),
              expression('receiver_user_id', '=', identity.user_high_id),
            ]),
            expression.and([
              expression('sender_user_id', '=', identity.user_high_id),
              expression('receiver_user_id', '=', identity.user_low_id),
            ]),
          ]),
        )
        .where('status', 'in', ['active', 'closed_by_match'])
        .execute();

      const recipientUserId =
        actorUserId === identity.user_low_id ? identity.user_high_id : identity.user_low_id;
      await insertNotification(transaction, {
        userId: recipientUserId,
        type: 'chat_closed',
        titleKey: 'notification.chat_closed.title',
        bodyKey: 'notification.chat_closed.body',
        payload: { matchId: write.matchId, chatSessionId: session.id },
        deduplicationKey: `unmatch:${write.matchId}:${recipientUserId}`,
        correlationId: write.command.requestId,
        causationId: write.command.commandId,
      });
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'match',
          aggregate_id: write.matchId,
          event_type: 'matching.unmatched.v1',
          schema_version: 1,
          payload: { matchId: write.matchId, chatSessionId: session.id },
          occurred_at: unmatchedAt,
          available_at: unmatchedAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: write.command.requestId,
          causation_id: write.command.commandId,
        })
        .execute();
      return result(
        {
          match_id: write.matchId,
          unmatched_at: unmatchedAt,
          report_window_expires_at: reportWindowExpiresAt,
        },
        false,
      );
    });
  }
}
