import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { ConsumeGuestPreviewWrite, GuestPreviewStore } from '@nakh/application';
import type { ConsumeGuestPreviewResult } from '@nakh/contracts';
import { ApplicationError, evaluateCapability } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

function requestHash(write: ConsumeGuestPreviewWrite): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandType: write.command.commandType,
        schemaVersion: write.command.schemaVersion,
        actor: write.command.actor,
        data: write.command.data,
      }),
    )
    .digest('hex');
}

export class PostgresGuestPreviewStore implements GuestPreviewStore {
  public constructor(private readonly database: NakhDatabase) {}

  public consumeGuestPreview(write: ConsumeGuestPreviewWrite): Promise<ConsumeGuestPreviewResult> {
    return this.database
      .transaction()
      .execute((transaction) => this.consumeGuestPreviewWithin(transaction, write));
  }

  public async consumeGuestPreviewWithin(
    transaction: NakhDatabase,
    write: ConsumeGuestPreviewWrite,
  ): Promise<ConsumeGuestPreviewResult> {
    if (write.command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const userId = write.command.actor.userId;
    const hash = requestHash(write);
    const claimed = await transaction
      .insertInto('platform.idempotency_records')
      .values({
        id: write.command.commandId,
        actor_user_id: userId,
        scope: write.command.commandType,
        idempotency_key: write.command.idempotencyKey,
        request_hash: hash,
        status: 'processing',
        response_json: null,
        expires_at: new Date(write.processedAt.getTime() + 86400000),
        created_at: write.processedAt,
        updated_at: write.processedAt,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (claimed === undefined) {
      const existing = await transaction
        .selectFrom('platform.idempotency_records')
        .select(['request_hash', 'status', 'response_json'])
        .where('actor_user_id', '=', userId)
        .where('scope', '=', write.command.commandType)
        .where('idempotency_key', '=', write.command.idempotencyKey)
        .executeTakeFirst();
      if (existing === undefined || existing.request_hash !== hash)
        throw new ApplicationError(
          'idempotency_conflict',
          'error.command.idempotency_conflict',
          409,
        );
      if (existing.status !== 'completed' || existing.response_json === null)
        throw new ApplicationError('conflict', 'error.command.in_progress', 409);
      return {
        ...(existing.response_json as unknown as ConsumeGuestPreviewResult),
        replayed: true,
      };
    }

    await transaction
      .selectFrom('identity.users')
      .select('id')
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const account = await transaction
      .selectFrom('identity.accounts')
      .select('state')
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const settings = await transaction
      .selectFrom('identity.user_settings')
      .select('visibility_enabled')
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const decision = evaluateCapability(
      {
        accountState: account.state,
        profileCompletion: null,
        visibilityEnabled: settings.visibility_enabled,
      },
      'guest_preview',
    );
    if (!decision.allowed)
      throw new ApplicationError('capability_denied', 'error.capability.denied', 403, {
        reason: decision.reasonCode ?? 'account_state_denied',
        requiredRoute: decision.requiredRoute,
      });

    const counter = await transaction
      .updateTable('identity.guest_preview_counters')
      .set({
        preview_count: sql<number>`preview_count + 1`,
        first_preview_at: sql<Date>`LEAST(COALESCE(first_preview_at, ${write.processedAt}), ${write.processedAt})`,
        last_preview_at: sql<Date>`GREATEST(COALESCE(last_preview_at, ${write.processedAt}), ${write.processedAt})`,
      })
      .where('user_id', '=', userId)
      .where((expression) => expression('preview_count', '<', expression.ref('limit_count')))
      .returning(['preview_count', 'limit_count'])
      .executeTakeFirst();
    if (counter === undefined)
      throw new ApplicationError(
        'guest_preview_limit_reached',
        'error.guest_preview.limit_reached',
        409,
      );
    const result: ConsumeGuestPreviewResult = {
      userId,
      count: counter.preview_count,
      limit: counter.limit_count,
      remaining: counter.limit_count - counter.preview_count,
      replayed: false,
    };
    await transaction
      .insertInto('platform.audit_logs')
      .values({
        id: write.auditId,
        category: 'product',
        event_type: 'identity.guest-preview-consumed.v1',
        actor_type: 'user',
        actor_user_id: userId,
        actor_admin_id: null,
        subject_type: 'guest_preview_counter',
        subject_id: userId,
        result_code: 'consumed',
        metadata_schema_version: 1,
        metadata: { count: result.count, limit: result.limit },
        request_id: write.command.requestId,
        command_id: write.command.commandId,
        occurred_at: write.processedAt,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('platform.outbox_events')
      .values({
        id: write.eventId,
        aggregate_type: 'user',
        aggregate_id: userId,
        event_type: 'identity.guest-preview-consumed.v1',
        schema_version: 1,
        payload: {
          userId,
          count: result.count,
          limit: result.limit,
          remaining: result.remaining,
        },
        occurred_at: write.processedAt,
        available_at: write.processedAt,
        published_at: null,
        last_error_code: null,
        lease_owner: null,
        lease_expires_at: null,
        correlation_id: write.command.requestId,
        causation_id: write.command.commandId,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('platform.idempotency_records')
      .set({ status: 'completed', response_json: result, updated_at: write.processedAt })
      .where('id', '=', write.command.commandId)
      .executeTakeFirstOrThrow();
    return result;
  }
}
