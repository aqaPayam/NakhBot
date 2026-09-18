import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { InteractionStore } from '@nakh/application';
import type { InteractionResult, MarkNotInterestedCommand, SendLikeCommand } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { lockUserPair } from './pair-lock.js';

type LikeGenerated = Parameters<InteractionStore['sendLike']>[1];
type RejectionGenerated = Parameters<InteractionStore['markNotInterested']>[1];
type InteractionCommand = SendLikeCommand | MarkNotInterestedCommand;

type UserFacts = Readonly<{
  userId: string;
  accountState: 'guest' | 'incomplete' | 'active' | 'restricted' | 'banned' | 'deleted';
  profileCompletion: 'incomplete' | 'complete' | 'invalid' | null;
  visibilityEnabled: boolean;
}>;

function commandHash(command: InteractionCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: command.commandType,
        schemaVersion: command.schemaVersion,
        actor: command.actor,
        data: command.data,
      }),
    )
    .digest('hex');
}

async function claimCommand(
  database: NakhDatabase,
  command: InteractionCommand,
  occurredAt: Date,
): Promise<InteractionResult | undefined> {
  const hash = commandHash(command);
  const claim = await database
    .insertInto('platform.idempotency_records')
    .values({
      id: command.commandId,
      actor_user_id: command.actor.userId,
      scope: command.commandType,
      idempotency_key: command.idempotencyKey,
      request_hash: hash,
      status: 'processing',
      response_json: null,
      expires_at: new Date(occurredAt.getTime() + 86_400_000),
      created_at: occurredAt,
      updated_at: occurredAt,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (claim !== undefined) return undefined;
  const existing = await database
    .selectFrom('platform.idempotency_records')
    .select(['request_hash', 'status', 'response_json'])
    .where('actor_user_id', '=', command.actor.userId)
    .where('scope', '=', command.commandType)
    .where('idempotency_key', '=', command.idempotencyKey)
    .executeTakeFirst();
  if (existing === undefined || existing.request_hash !== hash)
    throw new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
  if (existing.status !== 'completed' || existing.response_json === null)
    throw new ApplicationError('conflict', 'error.command.in_progress', 409);
  return { ...(existing.response_json as unknown as InteractionResult), replayed: true };
}

async function completeCommand(
  database: NakhDatabase,
  command: InteractionCommand,
  result: InteractionResult,
  occurredAt: Date,
): Promise<void> {
  await database
    .updateTable('platform.idempotency_records')
    .set({ status: 'completed', response_json: result, updated_at: occurredAt })
    .where('id', '=', command.commandId)
    .returning('id')
    .executeTakeFirstOrThrow();
}

async function lockAndLoadUsers(
  database: NakhDatabase,
  leftUserId: string,
  rightUserId: string,
): Promise<readonly UserFacts[]> {
  const users = await database
    .selectFrom('identity.users as user')
    .innerJoin('identity.accounts as account', 'account.user_id', 'user.id')
    .innerJoin('identity.user_settings as settings', 'settings.user_id', 'user.id')
    .innerJoin('profile.profiles as profile', 'profile.user_id', 'user.id')
    .select([
      'user.id as userId',
      'account.state as accountState',
      'profile.completion_status as profileCompletion',
      'settings.visibility_enabled as visibilityEnabled',
    ])
    .where('user.id', 'in', [leftUserId, rightUserId])
    .orderBy('user.id')
    .forUpdate()
    .execute();
  if (users.length !== 2)
    throw new ApplicationError('interaction_unavailable', 'error.interaction.unavailable', 409);
  return users;
}

function assertEligible(
  users: readonly UserFacts[],
  actorUserId: string,
  targetUserId: string,
  targetVisibilityRequired: boolean,
): void {
  const actor = users.find((user) => user.userId === actorUserId);
  const target = users.find((user) => user.userId === targetUserId);
  if (
    actor?.accountState !== 'active' ||
    actor.profileCompletion !== 'complete' ||
    !actor.visibilityEnabled ||
    target?.accountState !== 'active' ||
    target.profileCompletion !== 'complete' ||
    (targetVisibilityRequired && !target.visibilityEnabled)
  )
    throw new ApplicationError('interaction_unavailable', 'error.interaction.unavailable', 409);
}

async function assertPairAvailable(
  database: NakhDatabase,
  userLowId: string,
  userHighId: string,
): Promise<void> {
  const pair = await database
    .selectFrom('interaction.user_pair_states')
    .select('state')
    .where('user_low_id', '=', userLowId)
    .where('user_high_id', '=', userHighId)
    .executeTakeFirst();
  if (pair !== undefined)
    throw new ApplicationError('pair_unavailable', 'error.interaction.pair_unavailable', 409);
}

async function insertConsumption(
  database: NakhDatabase,
  viewerUserId: string,
  targetUserId: string,
  reason: 'like' | 'not_interested',
  occurredAt: Date,
): Promise<boolean> {
  const inserted = await database
    .insertInto('discovery.explore_consumptions')
    .values({
      viewer_user_id: viewerUserId,
      target_user_id: targetUserId,
      reason,
      consumed_at: occurredAt,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('viewer_user_id')
    .executeTakeFirst();
  return inserted !== undefined;
}

async function insertEvent(
  database: NakhDatabase,
  input: Readonly<{
    id: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: object;
    occurredAt: Date;
    correlationId: string;
    causationId: string;
  }>,
): Promise<void> {
  await database
    .insertInto('platform.outbox_events')
    .values({
      id: input.id,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      event_type: input.eventType,
      schema_version: 1,
      payload: input.payload,
      occurred_at: input.occurredAt,
      available_at: input.occurredAt,
      published_at: null,
      last_error_code: null,
      lease_owner: null,
      lease_expires_at: null,
      correlation_id: input.correlationId,
      causation_id: input.causationId,
    })
    .execute();
}

export class PostgresInteractionStore implements InteractionStore {
  public constructor(private readonly database: NakhDatabase) {}

  public sendLike(command: SendLikeCommand, generated: LikeGenerated): Promise<InteractionResult> {
    if (command.actor.kind !== 'user')
      return Promise.reject(
        new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401),
      );
    return this.database.transaction().execute(async (transaction) => {
      const pair = await lockUserPair(transaction, command.actor.userId, command.data.targetUserId);
      const replay = await claimCommand(transaction, command, generated.occurredAt);
      if (replay !== undefined) return replay;
      const users = await lockAndLoadUsers(transaction, pair.userLowId, pair.userHighId);
      await assertPairAvailable(transaction, pair.userLowId, pair.userHighId);
      const rejections = await transaction
        .selectFrom('interaction.not_interested')
        .select('id')
        .where((expression) =>
          expression.or([
            expression.and([
              expression('sender_user_id', '=', command.actor.userId),
              expression('receiver_user_id', '=', command.data.targetUserId),
            ]),
            expression.and([
              expression('sender_user_id', '=', command.data.targetUserId),
              expression('receiver_user_id', '=', command.actor.userId),
            ]),
          ]),
        )
        .execute();
      if (rejections.length !== 0)
        throw new ApplicationError('pair_unavailable', 'error.interaction.pair_unavailable', 409);
      const likes = await transaction
        .selectFrom('interaction.likes')
        .selectAll()
        .where((expression) =>
          expression.or([
            expression.and([
              expression('sender_user_id', '=', command.actor.userId),
              expression('receiver_user_id', '=', command.data.targetUserId),
            ]),
            expression.and([
              expression('sender_user_id', '=', command.data.targetUserId),
              expression('receiver_user_id', '=', command.actor.userId),
            ]),
          ]),
        )
        .orderBy('id')
        .forUpdate()
        .execute();
      const existing = likes.find((like) => like.sender_user_id === command.actor.userId);
      if (existing !== undefined)
        throw new ApplicationError(
          'like_already_exists',
          'error.interaction.like_already_exists',
          409,
        );
      const reverse = likes.find(
        (like) => like.sender_user_id === command.data.targetUserId && like.status === 'active',
      );
      assertEligible(users, command.actor.userId, command.data.targetUserId, reverse === undefined);
      const consumptionCreated = await insertConsumption(
        transaction,
        command.actor.userId,
        command.data.targetUserId,
        'like',
        generated.occurredAt,
      );
      await transaction
        .insertInto('interaction.likes')
        .values({
          id: generated.likeId,
          sender_user_id: command.actor.userId,
          receiver_user_id: command.data.targetUserId,
          status: 'active',
          created_at: generated.occurredAt,
          closed_at: null,
        })
        .execute();

      await insertEvent(transaction, {
        id: generated.likeEventId,
        aggregateType: 'like',
        aggregateId: generated.likeId,
        eventType: 'interaction.like-created.v1',
        payload: {
          likeId: generated.likeId,
          senderUserId: command.actor.userId,
          receiverUserId: command.data.targetUserId,
          notificationEligible: reverse === undefined,
        },
        occurredAt: generated.occurredAt,
        correlationId: command.requestId,
        causationId: command.commandId,
      });
      if (consumptionCreated)
        await insertEvent(transaction, {
          id: generated.consumptionEventId,
          aggregateType: 'explore_consumption',
          aggregateId: generated.likeId,
          eventType: 'discovery.consumption-created.v1',
          payload: {
            viewerUserId: command.actor.userId,
            targetUserId: command.data.targetUserId,
            reason: 'like',
          },
          occurredAt: generated.occurredAt,
          correlationId: command.requestId,
          causationId: command.commandId,
        });

      let result: InteractionResult;
      if (reverse === undefined) {
        result = { outcome: 'liked', interactionId: generated.likeId, replayed: false };
      } else {
        const likeIds = [generated.likeId, reverse.id].sort();
        await transaction
          .insertInto('matching.matches')
          .values({
            id: generated.matchId,
            user_low_id: pair.userLowId,
            user_high_id: pair.userHighId,
            source: 'mutual_like',
            source_like_a_id: likeIds[0]!,
            source_like_b_id: likeIds[1]!,
            source_nakh_id: null,
            status: 'active',
            created_at: generated.occurredAt,
            closed_at: null,
          })
          .execute();
        await transaction
          .insertInto('matching.match_participants')
          .values([
            {
              match_id: generated.matchId,
              user_id: pair.userLowId,
              joined_at: generated.occurredAt,
            },
            {
              match_id: generated.matchId,
              user_id: pair.userHighId,
              joined_at: generated.occurredAt,
            },
          ])
          .execute();
        await transaction
          .insertInto('interaction.user_pair_states')
          .values({
            user_low_id: pair.userLowId,
            user_high_id: pair.userHighId,
            state: 'matched',
            reason_code: 'mutual_like',
            changed_at: generated.occurredAt,
          })
          .execute();
        await transaction
          .insertInto('chat.chat_sessions')
          .values({
            id: generated.chatSessionId,
            match_id: generated.matchId,
            status: 'active',
            created_at: generated.occurredAt,
            closed_at: null,
            closed_reason: null,
          })
          .execute();
        await transaction
          .insertInto('chat.chat_participants')
          .values([
            {
              chat_session_id: generated.chatSessionId,
              user_id: pair.userLowId,
              last_read_at: null,
              muted_at: null,
              unlock_safety_warning_shown_at: null,
            },
            {
              chat_session_id: generated.chatSessionId,
              user_id: pair.userHighId,
              last_read_at: null,
              muted_at: null,
              unlock_safety_warning_shown_at: null,
            },
          ])
          .execute();
        const closedLikes = await transaction
          .updateTable('interaction.likes')
          .set({
            status: 'closed_by_match',
            closed_at: generated.occurredAt,
            version: sql<number>`version + 1`,
          })
          .where('id', 'in', likeIds)
          .where('status', '=', 'active')
          .returning('id')
          .execute();
        if (closedLikes.length !== 2)
          throw new ApplicationError('internal_error', 'error.internal', 500);
        await insertEvent(transaction, {
          id: generated.likeClosedEventId,
          aggregateType: 'match',
          aggregateId: generated.matchId,
          eventType: 'interaction.like-closed.v1',
          payload: { likeIds, reason: 'matched', matchId: generated.matchId },
          occurredAt: generated.occurredAt,
          correlationId: command.requestId,
          causationId: command.commandId,
        });
        await insertEvent(transaction, {
          id: generated.matchEventId,
          aggregateType: 'match',
          aggregateId: generated.matchId,
          eventType: 'matching.match-created.v1',
          payload: {
            matchId: generated.matchId,
            userLowId: pair.userLowId,
            userHighId: pair.userHighId,
            source: 'mutual_like',
          },
          occurredAt: generated.occurredAt,
          correlationId: command.requestId,
          causationId: command.commandId,
        });
        result = {
          outcome: 'matched',
          interactionId: generated.likeId,
          matchId: generated.matchId,
          replayed: false,
        };
      }
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: generated.auditId,
          category: 'product',
          event_type:
            result.outcome === 'matched'
              ? 'matching.match-created.v1'
              : 'interaction.like-created.v1',
          actor_type: 'user',
          actor_user_id: command.actor.userId,
          actor_admin_id: null,
          subject_type: result.outcome === 'matched' ? 'match' : 'like',
          subject_id: result.matchId ?? result.interactionId,
          result_code: result.outcome,
          metadata_schema_version: 1,
          metadata: { targetUserId: command.data.targetUserId },
          request_id: command.requestId,
          command_id: command.commandId,
          occurred_at: generated.occurredAt,
        })
        .execute();
      await completeCommand(transaction, command, result, generated.occurredAt);
      return result;
    });
  }

  public markNotInterested(
    command: MarkNotInterestedCommand,
    generated: RejectionGenerated,
  ): Promise<InteractionResult> {
    if (command.actor.kind !== 'user')
      return Promise.reject(
        new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401),
      );
    // Liked By unlock and Pending Nakh authorization arrive in M4/M5. The M3 adapter
    // must not turn a forged source into a free action against either later flow.
    if (command.data.source !== 'explore')
      return Promise.reject(
        new ApplicationError('interaction_unavailable', 'error.interaction.unavailable', 409),
      );
    return this.database.transaction().execute(async (transaction) => {
      const pair = await lockUserPair(transaction, command.actor.userId, command.data.targetUserId);
      const replay = await claimCommand(transaction, command, generated.occurredAt);
      if (replay !== undefined) return replay;
      const users = await lockAndLoadUsers(transaction, pair.userLowId, pair.userHighId);
      await assertPairAvailable(transaction, pair.userLowId, pair.userHighId);
      const rejections = await transaction
        .selectFrom('interaction.not_interested')
        .select(['id', 'sender_user_id'])
        .where((expression) =>
          expression.or([
            expression.and([
              expression('sender_user_id', '=', command.actor.userId),
              expression('receiver_user_id', '=', command.data.targetUserId),
            ]),
            expression.and([
              expression('sender_user_id', '=', command.data.targetUserId),
              expression('receiver_user_id', '=', command.actor.userId),
            ]),
          ]),
        )
        .execute();
      if (rejections.some((rejection) => rejection.sender_user_id === command.actor.userId))
        throw new ApplicationError(
          'not_interested_already_exists',
          'error.interaction.not_interested_already_exists',
          409,
        );
      if (rejections.length !== 0)
        throw new ApplicationError('pair_unavailable', 'error.interaction.pair_unavailable', 409);
      const likes = await transaction
        .selectFrom('interaction.likes')
        .select(['id', 'sender_user_id', 'status'])
        .where((expression) =>
          expression.or([
            expression.and([
              expression('sender_user_id', '=', command.actor.userId),
              expression('receiver_user_id', '=', command.data.targetUserId),
            ]),
            expression.and([
              expression('sender_user_id', '=', command.data.targetUserId),
              expression('receiver_user_id', '=', command.actor.userId),
            ]),
          ]),
        )
        .orderBy('id')
        .forUpdate()
        .execute();
      if (likes.some((like) => like.sender_user_id === command.actor.userId))
        throw new ApplicationError('interaction_unavailable', 'error.interaction.unavailable', 409);
      const receivedLike = likes.find((like) => like.sender_user_id === command.data.targetUserId);
      assertEligible(users, command.actor.userId, command.data.targetUserId, true);
      const consumptionCreated = await insertConsumption(
        transaction,
        command.actor.userId,
        command.data.targetUserId,
        'not_interested',
        generated.occurredAt,
      );
      await transaction
        .insertInto('interaction.not_interested')
        .values({
          id: generated.rejectionId,
          sender_user_id: command.actor.userId,
          receiver_user_id: command.data.targetUserId,
          source: command.data.source,
          created_at: generated.occurredAt,
        })
        .execute();
      if (receivedLike?.status === 'active') {
        const closedLike = await transaction
          .updateTable('interaction.likes')
          .set({
            status: 'closed_by_not_interested',
            closed_at: generated.occurredAt,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', receivedLike.id)
          .where('status', '=', 'active')
          .returning('id')
          .executeTakeFirst();
        if (closedLike === undefined)
          throw new ApplicationError('internal_error', 'error.internal', 500);
        await insertEvent(transaction, {
          id: generated.likeClosedEventId,
          aggregateType: 'like',
          aggregateId: receivedLike.id,
          eventType: 'interaction.like-closed.v1',
          payload: { likeId: receivedLike.id, reason: 'not_interested' },
          occurredAt: generated.occurredAt,
          correlationId: command.requestId,
          causationId: command.commandId,
        });
      }
      await insertEvent(transaction, {
        id: generated.rejectionEventId,
        aggregateType: 'not_interested',
        aggregateId: generated.rejectionId,
        eventType: 'interaction.not-interested-created.v1',
        payload: {
          rejectionId: generated.rejectionId,
          senderUserId: command.actor.userId,
          receiverUserId: command.data.targetUserId,
          source: command.data.source,
        },
        occurredAt: generated.occurredAt,
        correlationId: command.requestId,
        causationId: command.commandId,
      });
      if (consumptionCreated)
        await insertEvent(transaction, {
          id: generated.consumptionEventId,
          aggregateType: 'explore_consumption',
          aggregateId: generated.rejectionId,
          eventType: 'discovery.consumption-created.v1',
          payload: {
            viewerUserId: command.actor.userId,
            targetUserId: command.data.targetUserId,
            reason: 'not_interested',
          },
          occurredAt: generated.occurredAt,
          correlationId: command.requestId,
          causationId: command.commandId,
        });
      const result: InteractionResult = {
        outcome: 'rejected',
        interactionId: generated.rejectionId,
        replayed: false,
      };
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: generated.auditId,
          category: 'product',
          event_type: 'interaction.not-interested-created.v1',
          actor_type: 'user',
          actor_user_id: command.actor.userId,
          actor_admin_id: null,
          subject_type: 'not_interested',
          subject_id: generated.rejectionId,
          result_code: 'rejected',
          metadata_schema_version: 1,
          metadata: { targetUserId: command.data.targetUserId, source: command.data.source },
          request_id: command.requestId,
          command_id: command.commandId,
          occurred_at: generated.occurredAt,
        })
        .execute();
      await completeCommand(transaction, command, result, generated.occurredAt);
      return result;
    });
  }
}
