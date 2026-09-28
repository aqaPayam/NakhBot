import { sql } from 'kysely';

import type { AppealStore, UserAppealWrite } from '@nakh/application';
import type { AppealResult } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

function unavailable(): ApplicationError {
  return new ApplicationError('conflict', 'error.appeal.unavailable', 409);
}

export async function lockAppealAccount(database: NakhDatabase, userId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-account:' || ${userId}::text, 0))`.execute(
    database,
  );
  await database
    .selectFrom('identity.accounts')
    .select('user_id')
    .where('user_id', '=', userId)
    .forUpdate()
    .execute();
}

export async function currentBan(
  database: NakhDatabase,
  userId: string,
): Promise<string | undefined> {
  const row = await database
    .selectFrom('identity.accounts as a')
    .innerJoin('identity.account_state_history as h', 'h.user_id', 'a.user_id')
    .select('h.id')
    .where('a.user_id', '=', userId)
    .where('a.state', '=', 'banned')
    .where('h.next_state', '=', 'banned')
    .whereRef('h.changed_at', '=', 'a.state_changed_at')
    .orderBy('h.id', 'desc')
    .executeTakeFirst();
  return row?.id;
}

export class PostgresAppealStore implements AppealStore {
  public constructor(private readonly database: NakhDatabase) {}

  public currentBan(userId: string): Promise<string | undefined> {
    return currentBan(this.database, userId);
  }

  public submit(write: UserAppealWrite): Promise<AppealResult> {
    return this.database.transaction().execute(async (database) => {
      await lockAppealAccount(database, write.userId);
      const replays = await database
        .selectFrom('moderation.appeal_submissions as s')
        .innerJoin('moderation.user_appeals as a', 'a.id', 's.appeal_id')
        .select(['a.id', 'a.ban_state_history_id', 'a.submitted_at', 's.request_digest'])
        .where('s.user_id', '=', write.userId)
        .where((eb) =>
          eb.or([
            eb('s.command_id', '=', write.commandId),
            eb('s.idempotency_key', '=', write.idempotencyKey),
          ]),
        )
        .execute();
      if (replays.length > 0) {
        const replay = replays[0]!;
        if (
          replays.length !== 1 ||
          replay.request_digest !== write.requestDigest ||
          replay.ban_state_history_id !== write.banHistoryId
        )
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        return {
          appealId: replay.id,
          status: 'submitted',
          version: 1,
          changedAt: replay.submitted_at.toISOString(),
          replayed: true,
        };
      }
      if ((await currentBan(database, write.userId)) !== write.banHistoryId) throw unavailable();
      await database
        .selectFrom('identity.account_state_history')
        .select('id')
        .where('id', '=', write.banHistoryId)
        .forUpdate()
        .execute();
      const existing = await database
        .selectFrom('moderation.user_appeals')
        .select('id')
        .where('ban_state_history_id', '=', write.banHistoryId)
        .executeTakeFirst();
      if (existing !== undefined) throw unavailable();
      const appeal = await database
        .insertInto('moderation.user_appeals')
        .values({
          id: write.appealId,
          user_id: write.userId,
          ban_state_history_id: write.banHistoryId,
          message_text: write.normalizedText,
          reviewed_by_admin_id: null,
          admin_note: null,
          reviewed_at: null,
        })
        .returning('submitted_at')
        .executeTakeFirstOrThrow();
      await database
        .insertInto('moderation.appeal_submissions')
        .values({
          appeal_id: write.appealId,
          user_id: write.userId,
          command_id: write.commandId,
          idempotency_key: write.idempotencyKey,
          request_digest: write.requestDigest,
        })
        .execute();
      await database
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'user_appeal',
          aggregate_id: write.appealId,
          event_type: 'moderation.appeal-changed.v1',
          schema_version: 1,
          payload: { appealId: write.appealId, status: 'submitted', version: 1 },
          occurred_at: appeal.submitted_at,
          available_at: appeal.submitted_at,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: write.requestId,
          causation_id: write.commandId,
        })
        .execute();
      return {
        appealId: write.appealId,
        status: 'submitted',
        version: 1,
        changedAt: appeal.submitted_at.toISOString(),
        replayed: false,
      };
    });
  }
}
