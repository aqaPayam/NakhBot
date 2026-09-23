import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type {
  CancelPendingNakhWrite,
  CreatePendingNakhWrite,
  EditPendingNakhWrite,
  PendingNakhKeyset,
  PendingNakhCancelStore,
  PendingNakhEditStore,
  PendingNakhReadStore,
  PendingNakhStore,
  SenderPendingNakhReadPage,
} from '@nakh/application';
import type {
  CancelPendingNakhCommand,
  CreatePendingNakhCommand,
  EditPendingNakhCommand,
  GetPendingNakhPageQuery,
  PendingNakhResult,
} from '@nakh/contracts';
import {
  ApplicationError,
  MAX_PENDING_NAKHES_PER_SENDER,
  NAKH_STARS_COST,
  PENDING_NAKH_LIFETIME_MS,
} from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { lockUserPair } from './pair-lock.js';

function commandHash(
  command: CreatePendingNakhCommand | EditPendingNakhCommand | CancelPendingNakhCommand,
): string {
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

function replayResult(value: Readonly<Record<string, unknown>>): PendingNakhResult {
  return {
    pendingNakhId: String(value.pendingNakhId),
    status: String(value.status) as PendingNakhResult['status'],
    expiresAt: String(value.expiresAt),
    version: Number(value.version),
    replayed: true,
  };
}

export class PostgresPendingNakhStore
  implements PendingNakhStore, PendingNakhReadStore, PendingNakhEditStore, PendingNakhCancelStore
{
  public constructor(private readonly database: NakhDatabase) {}

  public readSenderPage(
    query: GetPendingNakhPageQuery,
    after?: PendingNakhKeyset,
  ): Promise<SenderPendingNakhReadPage> {
    if (query.actor.kind !== 'user')
      return Promise.reject(
        new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401),
      );
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50)
      return Promise.reject(
        new ApplicationError('invalid_request', 'error.nakh.page_limit_invalid', 400),
      );
    return this.database
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (transaction) => {
        const sender = await transaction
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', query.actor.userId)
          .executeTakeFirst();
        if (sender?.state !== 'active')
          throw new ApplicationError('capability_denied', 'error.capability.denied', 403);

        const countRow = await transaction
          .selectFrom('nakh.pending_nakhes')
          .select((expression) => expression.fn.countAll<string>().as('count'))
          .where('sender_user_id', '=', query.actor.userId)
          .where('status', '=', 'pending_payment')
          .executeTakeFirstOrThrow();
        const totalCount = Number(countRow.count);
        if (!Number.isSafeInteger(totalCount))
          throw new ApplicationError('internal_error', 'error.internal', 500);

        let pageQuery = transaction
          .selectFrom('nakh.pending_nakhes as pending')
          .innerJoin('nakh.nakh_flows as flow', 'flow.id', 'pending.nakh_flow_id')
          .innerJoin('profile.profiles as target', 'target.user_id', 'flow.receiver_user_id')
          .select([
            'pending.id as pending_nakh_id',
            'target.name as target_name',
            'pending.text',
            'pending.created_at',
            'pending.expires_at',
            'pending.version',
          ])
          .where('pending.sender_user_id', '=', query.actor.userId)
          .where('pending.status', '=', 'pending_payment');
        if (after !== undefined)
          pageQuery = pageQuery.where((expression) =>
            expression.or([
              expression('pending.created_at', '<', after.createdAt),
              expression.and([
                expression('pending.created_at', '=', after.createdAt),
                expression('pending.id', '<', after.pendingNakhId),
              ]),
            ]),
          );
        const rows = await pageQuery
          .orderBy('pending.created_at', 'desc')
          .orderBy('pending.id', 'desc')
          .limit(query.limit + 1)
          .execute();
        return {
          totalCount,
          rows: rows.slice(0, query.limit).map((row) => ({
            pendingNakhId: row.pending_nakh_id,
            targetName: row.target_name,
            text: row.text,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            version: row.version,
          })),
          hasMore: rows.length > query.limit,
        };
      });
  }

  public async editPending(write: EditPendingNakhWrite): Promise<PendingNakhResult> {
    const { command } = write;
    const senderUserId = command.actor.userId;
    const requestHash = commandHash(command);
    return this.database.transaction().execute(async (transaction) => {
      const counter = await transaction
        .selectFrom('platform.user_counters')
        .select('user_id')
        .where('user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (counter === undefined)
        throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);

      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: command.commandId,
          actor_user_id: senderUserId,
          scope: command.commandType,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(Date.parse(command.occurredAt) + 86_400_000),
          created_at: new Date(command.occurredAt),
          updated_at: new Date(command.occurredAt),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (claimed === undefined) {
        const existing = await transaction
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', senderUserId)
          .where('scope', '=', command.commandType)
          .where('idempotency_key', '=', command.idempotencyKey)
          .executeTakeFirst();
        if (existing === undefined || existing.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        if (existing.status !== 'completed' || existing.response_json === null)
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        return replayResult(existing.response_json);
      }

      const locator = await transaction
        .selectFrom('nakh.pending_nakhes')
        .select('nakh_flow_id')
        .where('id', '=', command.data.pendingNakhId)
        .where('sender_user_id', '=', senderUserId)
        .executeTakeFirst();
      if (locator === undefined)
        throw new ApplicationError('not_found', 'error.nakh.not_found', 404);
      const flow = await transaction
        .selectFrom('nakh.nakh_flows')
        .select('id')
        .where('id', '=', locator.nakh_flow_id)
        .where('sender_user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (flow === undefined) throw new ApplicationError('not_found', 'error.nakh.not_found', 404);
      const pending = await transaction
        .selectFrom('nakh.pending_nakhes')
        .select(['id', 'text', 'status', 'expires_at', 'version'])
        .where('id', '=', command.data.pendingNakhId)
        .where('sender_user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (pending === undefined)
        throw new ApplicationError('not_found', 'error.nakh.not_found', 404);
      if (pending.status !== 'pending_payment')
        throw new ApplicationError('nakh_terminal', 'error.nakh.terminal', 409);
      if (pending.version !== command.data.expectedVersion)
        throw new ApplicationError('version_conflict', 'error.nakh.version_conflict', 409);

      const time = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(transaction);
      const now = time.rows[0]!.now;
      let version = pending.version;
      if (pending.text !== command.data.text) {
        const updated = await transaction
          .updateTable('nakh.pending_nakhes')
          .set({ text: command.data.text, version: sql<number>`version + 1` })
          .where('id', '=', pending.id)
          .where('status', '=', 'pending_payment')
          .where('version', '=', pending.version)
          .returning('version')
          .executeTakeFirstOrThrow();
        version = updated.version;
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.pendingEventId,
            aggregate_type: 'pending_nakh',
            aggregate_id: pending.id,
            event_type: 'nakh.pending-updated.v1',
            schema_version: 1,
            payload: { pendingNakhId: pending.id, senderUserId },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: command.requestId,
            causation_id: command.commandId,
          })
          .execute();
      }

      const result: PendingNakhResult = {
        pendingNakhId: pending.id,
        status: 'pending_payment',
        expiresAt: pending.expires_at.toISOString(),
        version,
        replayed: false,
      };
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: now })
        .where('id', '=', command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }

  public async cancelPending(write: CancelPendingNakhWrite): Promise<PendingNakhResult> {
    const { command } = write;
    const senderUserId = command.actor.userId;
    const requestHash = commandHash(command);
    return this.database.transaction().execute(async (transaction) => {
      const counter = await transaction
        .selectFrom('platform.user_counters')
        .select(['user_id', 'pending_nakh_count'])
        .where('user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (counter === undefined)
        throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);

      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: command.commandId,
          actor_user_id: senderUserId,
          scope: command.commandType,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(Date.parse(command.occurredAt) + 86_400_000),
          created_at: new Date(command.occurredAt),
          updated_at: new Date(command.occurredAt),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (claimed === undefined) {
        const existing = await transaction
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', senderUserId)
          .where('scope', '=', command.commandType)
          .where('idempotency_key', '=', command.idempotencyKey)
          .executeTakeFirst();
        if (existing === undefined || existing.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        if (existing.status !== 'completed' || existing.response_json === null)
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        return replayResult(existing.response_json);
      }

      const locator = await transaction
        .selectFrom('nakh.pending_nakhes as pending')
        .innerJoin('nakh.nakh_flows as flow', 'flow.id', 'pending.nakh_flow_id')
        .select(['pending.nakh_flow_id', 'flow.receiver_user_id'])
        .where('pending.id', '=', command.data.pendingNakhId)
        .where('pending.sender_user_id', '=', senderUserId)
        .executeTakeFirst();
      if (locator === undefined)
        throw new ApplicationError('not_found', 'error.nakh.not_found', 404);

      const receiverUserId = locator.receiver_user_id;
      const pair = await lockUserPair(transaction, senderUserId, receiverUserId);
      const users = await transaction
        .selectFrom('identity.users as user')
        .innerJoin('identity.accounts as account', 'account.user_id', 'user.id')
        .innerJoin('profile.profiles as profile', 'profile.user_id', 'user.id')
        .select(['user.id', 'account.state', 'profile.completion_status'])
        .where('user.id', 'in', [pair.userLowId, pair.userHighId])
        .orderBy('user.id')
        .forUpdate()
        .execute();
      if (
        users.length !== 2 ||
        users.some((user) => user.state !== 'active' || user.completion_status !== 'complete')
      )
        throw new ApplicationError('interaction_unavailable', 'error.interaction.unavailable', 409);

      const pairState = await transaction
        .selectFrom('interaction.user_pair_states')
        .select('state')
        .where('user_low_id', '=', pair.userLowId)
        .where('user_high_id', '=', pair.userHighId)
        .executeTakeFirst();
      if (pairState !== undefined)
        throw new ApplicationError('pair_unavailable', 'error.interaction.pair_unavailable', 409);

      const flow = await transaction
        .selectFrom('nakh.nakh_flows')
        .select('id')
        .where('id', '=', locator.nakh_flow_id)
        .where('sender_user_id', '=', senderUserId)
        .where('receiver_user_id', '=', receiverUserId)
        .forUpdate()
        .executeTakeFirst();
      if (flow === undefined) throw new ApplicationError('not_found', 'error.nakh.not_found', 404);
      const pending = await transaction
        .selectFrom('nakh.pending_nakhes')
        .select(['id', 'status', 'pending_payment_id', 'expires_at', 'version'])
        .where('id', '=', command.data.pendingNakhId)
        .where('nakh_flow_id', '=', flow.id)
        .where('sender_user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (pending === undefined)
        throw new ApplicationError('not_found', 'error.nakh.not_found', 404);
      if (pending.status !== 'pending_payment')
        throw new ApplicationError('nakh_terminal', 'error.nakh.terminal', 409);
      if (pending.version !== command.data.expectedVersion)
        throw new ApplicationError('version_conflict', 'error.nakh.version_conflict', 409);

      const payment = await transaction
        .selectFrom('billing.pending_payments')
        .select(['id', 'status', 'version'])
        .where('id', '=', pending.pending_payment_id)
        .where('user_id', '=', senderUserId)
        .where('reason', '=', 'send_nakh')
        .where('target_type', '=', 'pending_nakh')
        .where('target_id', '=', pending.id)
        .forUpdate()
        .executeTakeFirst();
      if (payment === undefined || payment.status !== 'pending')
        throw new ApplicationError('nakh_terminal', 'error.nakh.terminal', 409);
      const paymentAttempts = await transaction
        .selectFrom('billing.payment_records')
        .select(['id', 'status'])
        .where('pending_payment_id', '=', payment.id)
        .orderBy('id')
        .forUpdate()
        .execute();
      if (paymentAttempts.some((attempt) => attempt.status === 'paid'))
        throw new ApplicationError('nakh_terminal', 'error.nakh.terminal', 409);

      const rejections = await transaction
        .selectFrom('interaction.not_interested')
        .select(['id', 'sender_user_id'])
        .where((expression) =>
          expression.or([
            expression.and([
              expression('sender_user_id', '=', senderUserId),
              expression('receiver_user_id', '=', receiverUserId),
            ]),
            expression.and([
              expression('sender_user_id', '=', receiverUserId),
              expression('receiver_user_id', '=', senderUserId),
            ]),
          ]),
        )
        .execute();
      if (rejections.length !== 0)
        throw new ApplicationError('pair_unavailable', 'error.interaction.pair_unavailable', 409);
      const likes = await transaction
        .selectFrom('interaction.likes')
        .select(['id', 'sender_user_id', 'status'])
        .where((expression) =>
          expression.or([
            expression.and([
              expression('sender_user_id', '=', senderUserId),
              expression('receiver_user_id', '=', receiverUserId),
            ]),
            expression.and([
              expression('sender_user_id', '=', receiverUserId),
              expression('receiver_user_id', '=', senderUserId),
            ]),
          ]),
        )
        .orderBy('id')
        .forUpdate()
        .execute();
      if (likes.some((like) => like.sender_user_id === senderUserId))
        throw new ApplicationError('interaction_unavailable', 'error.interaction.unavailable', 409);

      const time = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(transaction);
      const now = time.rows[0]!.now;
      const reverseLike = likes.find(
        (like) => like.sender_user_id === receiverUserId && like.status === 'active',
      );
      let auditSubjectType: 'like' | 'match' | 'not_interested';
      let auditSubjectId: string;
      let auditResult: 'liked' | 'matched' | 'rejected';

      if (command.data.resolution === 'converted_to_like') {
        await transaction
          .insertInto('interaction.likes')
          .values({
            id: write.interactionId,
            sender_user_id: senderUserId,
            receiver_user_id: receiverUserId,
            status: 'active',
            created_at: now,
            closed_at: null,
          })
          .execute();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.interactionEventId,
            aggregate_type: 'like',
            aggregate_id: write.interactionId,
            event_type: 'interaction.like-created.v1',
            schema_version: 1,
            payload: {
              likeId: write.interactionId,
              senderUserId,
              receiverUserId,
              notificationEligible: reverseLike === undefined,
              source: 'cancelled_pending_nakh',
            },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: command.requestId,
            causation_id: command.commandId,
          })
          .execute();
        if (reverseLike === undefined) {
          auditSubjectType = 'like';
          auditSubjectId = write.interactionId;
          auditResult = 'liked';
        } else {
          const likeIds = [write.interactionId, reverseLike.id].sort();
          await transaction
            .insertInto('matching.matches')
            .values({
              id: write.matchId,
              user_low_id: pair.userLowId,
              user_high_id: pair.userHighId,
              source: 'mutual_like',
              source_like_a_id: likeIds[0]!,
              source_like_b_id: likeIds[1]!,
              source_nakh_id: null,
              status: 'active',
              created_at: now,
              closed_at: null,
            })
            .execute();
          await transaction
            .insertInto('matching.match_participants')
            .values([
              { match_id: write.matchId, user_id: pair.userLowId, joined_at: now },
              { match_id: write.matchId, user_id: pair.userHighId, joined_at: now },
            ])
            .execute();
          await transaction
            .insertInto('interaction.user_pair_states')
            .values({
              user_low_id: pair.userLowId,
              user_high_id: pair.userHighId,
              state: 'matched',
              reason_code: 'mutual_like',
              changed_at: now,
            })
            .execute();
          await transaction
            .insertInto('chat.chat_sessions')
            .values({
              id: write.chatSessionId,
              match_id: write.matchId,
              status: 'active',
              created_at: now,
              closed_at: null,
              closed_reason: null,
            })
            .execute();
          await transaction
            .insertInto('chat.chat_participants')
            .values([
              {
                chat_session_id: write.chatSessionId,
                user_id: pair.userLowId,
                last_read_at: null,
                muted_at: null,
                unlock_safety_warning_shown_at: null,
              },
              {
                chat_session_id: write.chatSessionId,
                user_id: pair.userHighId,
                last_read_at: null,
                muted_at: null,
                unlock_safety_warning_shown_at: null,
              },
            ])
            .execute();
          const closedLikes = await transaction
            .updateTable('interaction.likes')
            .set({ status: 'closed_by_match', closed_at: now, version: sql<number>`version + 1` })
            .where('id', 'in', likeIds)
            .where('status', '=', 'active')
            .returning('id')
            .execute();
          if (closedLikes.length !== 2)
            throw new ApplicationError('internal_error', 'error.internal', 500);
          await transaction
            .insertInto('platform.outbox_events')
            .values([
              {
                id: write.likeClosedEventId,
                aggregate_type: 'match',
                aggregate_id: write.matchId,
                event_type: 'interaction.like-closed.v1',
                schema_version: 1,
                payload: { likeIds, reason: 'matched', matchId: write.matchId },
                occurred_at: now,
                available_at: now,
                published_at: null,
                last_error_code: null,
                lease_owner: null,
                lease_expires_at: null,
                correlation_id: command.requestId,
                causation_id: command.commandId,
              },
              {
                id: write.matchEventId,
                aggregate_type: 'match',
                aggregate_id: write.matchId,
                event_type: 'matching.match-created.v1',
                schema_version: 1,
                payload: {
                  matchId: write.matchId,
                  userLowId: pair.userLowId,
                  userHighId: pair.userHighId,
                  source: 'mutual_like',
                },
                occurred_at: now,
                available_at: now,
                published_at: null,
                last_error_code: null,
                lease_owner: null,
                lease_expires_at: null,
                correlation_id: command.requestId,
                causation_id: command.commandId,
              },
            ])
            .execute();
          auditSubjectType = 'match';
          auditSubjectId = write.matchId;
          auditResult = 'matched';
        }
      } else {
        await transaction
          .insertInto('interaction.not_interested')
          .values({
            id: write.interactionId,
            sender_user_id: senderUserId,
            receiver_user_id: receiverUserId,
            source: 'cancelled_pending_nakh',
            created_at: now,
          })
          .execute();
        if (reverseLike !== undefined) {
          await transaction
            .updateTable('interaction.likes')
            .set({
              status: 'closed_by_not_interested',
              closed_at: now,
              version: sql<number>`version + 1`,
            })
            .where('id', '=', reverseLike.id)
            .where('status', '=', 'active')
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto('platform.outbox_events')
            .values({
              id: write.likeClosedEventId,
              aggregate_type: 'like',
              aggregate_id: reverseLike.id,
              event_type: 'interaction.like-closed.v1',
              schema_version: 1,
              payload: { likeId: reverseLike.id, reason: 'not_interested' },
              occurred_at: now,
              available_at: now,
              published_at: null,
              last_error_code: null,
              lease_owner: null,
              lease_expires_at: null,
              correlation_id: command.requestId,
              causation_id: command.commandId,
            })
            .execute();
        }
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.interactionEventId,
            aggregate_type: 'not_interested',
            aggregate_id: write.interactionId,
            event_type: 'interaction.not-interested-created.v1',
            schema_version: 1,
            payload: {
              rejectionId: write.interactionId,
              senderUserId,
              receiverUserId,
              source: 'cancelled_pending_nakh',
            },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: command.requestId,
            causation_id: command.commandId,
          })
          .execute();
        auditSubjectType = 'not_interested';
        auditSubjectId = write.interactionId;
        auditResult = 'rejected';
      }

      await transaction
        .updateTable('billing.payment_records')
        .set({
          status: 'cancelled',
          cancelled_at: now,
          version: sql<number>`version + 1`,
        })
        .where('pending_payment_id', '=', payment.id)
        .where('status', '=', 'pending')
        .execute();
      await transaction
        .updateTable('billing.pending_payments')
        .set({ status: 'cancelled', resolved_at: now, version: sql<number>`version + 1` })
        .where('id', '=', payment.id)
        .where('status', '=', 'pending')
        .where('version', '=', payment.version)
        .executeTakeFirstOrThrow();
      const updated = await transaction
        .updateTable('nakh.pending_nakhes')
        .set({
          status: 'cancelled',
          cancelled_at: now,
          cancel_resolution: command.data.resolution,
          version: sql<number>`version + 1`,
        })
        .where('id', '=', pending.id)
        .where('status', '=', 'pending_payment')
        .where('version', '=', pending.version)
        .returning('version')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('platform.user_counters')
        .set({
          pending_nakh_count: sql<number>`pending_nakh_count - 1`,
          version: sql<number>`version + 1`,
          updated_at: now,
        })
        .where('user_id', '=', senderUserId)
        .where('pending_nakh_count', '>', 0)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.pendingEventId,
          aggregate_type: 'pending_nakh',
          aggregate_id: pending.id,
          event_type: 'nakh.cancelled.v1',
          schema_version: 1,
          payload: { pendingNakhId: pending.id, senderUserId, resolution: command.data.resolution },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: command.requestId,
          causation_id: command.commandId,
        })
        .execute();
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: write.auditId,
          category: 'product',
          event_type: 'nakh.cancelled.v1',
          actor_type: 'user',
          actor_user_id: senderUserId,
          actor_admin_id: null,
          subject_type: auditSubjectType,
          subject_id: auditSubjectId,
          result_code: auditResult,
          metadata_schema_version: 1,
          metadata: {
            pendingNakhId: pending.id,
            receiverUserId,
            resolution: command.data.resolution,
          },
          request_id: command.requestId,
          command_id: command.commandId,
          occurred_at: now,
        })
        .execute();

      const result: PendingNakhResult = {
        pendingNakhId: pending.id,
        status: 'cancelled',
        expiresAt: pending.expires_at.toISOString(),
        version: updated.version,
        replayed: false,
      };
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: now })
        .where('id', '=', command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }

  public async createPending(write: CreatePendingNakhWrite): Promise<PendingNakhResult> {
    const { command } = write;
    const senderUserId = command.actor.userId;
    const targetUserId = command.data.targetUserId;
    const requestHash = commandHash(command);
    return this.database.transaction().execute(async (transaction) => {
      const counter = await transaction
        .selectFrom('platform.user_counters')
        .selectAll()
        .where('user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (counter === undefined)
        throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);

      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: command.commandId,
          actor_user_id: senderUserId,
          scope: command.commandType,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(Date.parse(command.occurredAt) + 86_400_000),
          created_at: new Date(command.occurredAt),
          updated_at: new Date(command.occurredAt),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (claimed === undefined) {
        const existing = await transaction
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', senderUserId)
          .where('scope', '=', command.commandType)
          .where('idempotency_key', '=', command.idempotencyKey)
          .executeTakeFirst();
        if (existing === undefined || existing.request_hash !== requestHash)
          throw new ApplicationError(
            'idempotency_conflict',
            'error.command.idempotency_conflict',
            409,
          );
        if (existing.status !== 'completed' || existing.response_json === null)
          throw new ApplicationError('conflict', 'error.command.in_progress', 409);
        return replayResult(existing.response_json);
      }

      const pair = await lockUserPair(transaction, senderUserId, targetUserId);
      const users = await transaction
        .selectFrom('identity.users as user')
        .innerJoin('identity.accounts as account', 'account.user_id', 'user.id')
        .innerJoin('identity.user_settings as settings', 'settings.user_id', 'user.id')
        .innerJoin('profile.profiles as profile', 'profile.user_id', 'user.id')
        .select([
          'user.id',
          'account.state',
          'settings.visibility_enabled',
          'profile.completion_status',
        ])
        .where('user.id', 'in', [pair.userLowId, pair.userHighId])
        .orderBy('user.id')
        .forUpdate()
        .execute();
      if (
        users.length !== 2 ||
        users.some(
          (user) =>
            user.state !== 'active' ||
            user.completion_status !== 'complete' ||
            !user.visibility_enabled,
        )
      )
        throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);

      const [pairState, existingFlow, incompatibleLike, incompatibleRejection] = await Promise.all([
        transaction
          .selectFrom('interaction.user_pair_states')
          .select('state')
          .where('user_low_id', '=', pair.userLowId)
          .where('user_high_id', '=', pair.userHighId)
          .executeTakeFirst(),
        transaction
          .selectFrom('nakh.nakh_flows')
          .select('id')
          .where('sender_user_id', '=', senderUserId)
          .where('receiver_user_id', '=', targetUserId)
          .executeTakeFirst(),
        transaction
          .selectFrom('interaction.likes')
          .select('id')
          .where((expression) =>
            expression.or([
              expression.and([
                expression('sender_user_id', '=', senderUserId),
                expression('receiver_user_id', '=', targetUserId),
              ]),
              expression.and([
                expression('sender_user_id', '=', targetUserId),
                expression('receiver_user_id', '=', senderUserId),
              ]),
            ]),
          )
          .executeTakeFirst(),
        transaction
          .selectFrom('interaction.not_interested')
          .select('id')
          .where((expression) =>
            expression.or([
              expression.and([
                expression('sender_user_id', '=', senderUserId),
                expression('receiver_user_id', '=', targetUserId),
              ]),
              expression.and([
                expression('sender_user_id', '=', targetUserId),
                expression('receiver_user_id', '=', senderUserId),
              ]),
            ]),
          )
          .executeTakeFirst(),
      ]);
      if (existingFlow !== undefined)
        throw new ApplicationError('nakh_flow_exists', 'error.nakh.flow_exists', 409);
      if (
        pairState !== undefined ||
        incompatibleLike !== undefined ||
        incompatibleRejection !== undefined
      )
        throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);
      if (counter.pending_nakh_count >= MAX_PENDING_NAKHES_PER_SENDER)
        throw new ApplicationError('nakh_quota_reached', 'error.nakh.quota_reached', 409);

      const time = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(transaction);
      const now = time.rows[0]!.now;
      const expiresAt = new Date(now.getTime() + PENDING_NAKH_LIFETIME_MS);
      await transaction
        .insertInto('nakh.nakh_flows')
        .values({
          id: write.flowId,
          sender_user_id: senderUserId,
          receiver_user_id: targetUserId,
          created_at: now,
        })
        .execute();
      await transaction
        .insertInto('discovery.explore_consumptions')
        .values({
          viewer_user_id: senderUserId,
          target_user_id: targetUserId,
          reason: 'nakh_flow',
          consumed_at: now,
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
      await transaction
        .insertInto('billing.pending_payments')
        .values({
          id: write.pendingPaymentId,
          user_id: senderUserId,
          reason: 'send_nakh',
          target_type: 'pending_nakh',
          target_id: write.pendingNakhId,
          funding_type: 'telegram_stars',
          required_credits: null,
          required_stars: NAKH_STARS_COST.toString(),
          package_code_snapshot: null,
          package_credit_amount_snapshot: null,
          idempotency_key: `nakh-payment:${write.pendingNakhId}`,
          request_hash: requestHash,
          created_at: now,
          expires_at: expiresAt,
          resolved_at: null,
        })
        .execute();
      const pending = await transaction
        .insertInto('nakh.pending_nakhes')
        .values({
          id: write.pendingNakhId,
          nakh_flow_id: write.flowId,
          sender_user_id: senderUserId,
          text: command.data.text,
          pending_payment_id: write.pendingPaymentId,
          auto_settle_authorized_at: now,
          authorization_source: 'explore',
          authorized_at: now,
          created_at: now,
          expires_at: expiresAt,
          paid_at: null,
          cancelled_at: null,
          expired_at: null,
          closed_at: null,
          cancel_resolution: null,
          last_reminder_at: null,
          idempotency_key: command.idempotencyKey,
          request_hash: requestHash,
        })
        .returning(['id', 'status', 'expires_at', 'version'])
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('platform.user_counters')
        .set({
          pending_nakh_count: sql<number>`pending_nakh_count + 1`,
          version: sql<number>`version + 1`,
          updated_at: now,
        })
        .where('user_id', '=', senderUserId)
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto('platform.outbox_events')
        .values([
          {
            id: write.flowEventId,
            aggregate_type: 'nakh_flow',
            aggregate_id: write.flowId,
            event_type: 'nakh.flow-created.v1',
            schema_version: 1,
            payload: { flowId: write.flowId, senderUserId, receiverUserId: targetUserId },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: command.requestId,
            causation_id: command.commandId,
          },
          {
            id: write.pendingEventId,
            aggregate_type: 'pending_nakh',
            aggregate_id: write.pendingNakhId,
            event_type: 'nakh.pending-created.v1',
            schema_version: 1,
            payload: { pendingNakhId: write.pendingNakhId, senderUserId },
            occurred_at: now,
            available_at: now,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: command.requestId,
            causation_id: command.commandId,
          },
        ])
        .execute();
      const result: PendingNakhResult = {
        pendingNakhId: pending.id,
        status: pending.status,
        expiresAt: pending.expires_at.toISOString(),
        version: pending.version,
        replayed: false,
      };
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: now })
        .where('id', '=', command.commandId)
        .executeTakeFirstOrThrow();
      return result;
    });
  }
}
