import { sql } from 'kysely';

import type { CandidateDeliveryResult, CandidateDeliveryStore } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { lockUserPair } from './pair-lock.js';

type DeliveredGenerated = Readonly<{
  auditId: string;
  deliveryEventId: string;
  consumptionEventId: string;
  processedAt: Date;
}>;
type FailedGenerated = Readonly<{ auditId: string; eventId: string; processedAt: Date }>;

function notFound(): never {
  throw new ApplicationError('not_found', 'error.discovery.delivery_not_found', 404);
}

function conflict(): never {
  throw new ApplicationError('conflict', 'error.discovery.delivery_state_conflict', 409);
}

async function lockUsers(
  database: NakhDatabase,
  viewerUserId: string,
  targetUserId: string,
): Promise<void> {
  const users = await database
    .selectFrom('identity.users')
    .select('id')
    .where('id', 'in', [viewerUserId, targetUserId])
    .orderBy('id')
    .forUpdate()
    .execute();
  if (users.length !== 2) notFound();
}

export class PostgresCandidateDeliveryStore implements CandidateDeliveryStore {
  public constructor(private readonly database: NakhDatabase) {}

  public recordDelivered(
    input: Readonly<{ deliveryId: string; providerMessageId: string }>,
    generated: DeliveredGenerated,
  ): Promise<CandidateDeliveryResult> {
    return this.database.transaction().execute(async (transaction) => {
      const snapshot = await transaction
        .selectFrom('discovery.candidate_deliveries')
        .select(['viewer_user_id', 'target_user_id'])
        .where('id', '=', input.deliveryId)
        .executeTakeFirst();
      if (snapshot === undefined) notFound();
      await lockUserPair(transaction, snapshot.viewer_user_id, snapshot.target_user_id);
      await lockUsers(transaction, snapshot.viewer_user_id, snapshot.target_user_id);
      const delivery = await transaction
        .selectFrom('discovery.candidate_deliveries')
        .selectAll()
        .where('id', '=', input.deliveryId)
        .forUpdate()
        .executeTakeFirst();
      if (delivery === undefined) notFound();
      if (delivery.state === 'delivered') {
        if (delivery.provider_message_id !== input.providerMessageId) conflict();
        return {
          deliveryId: delivery.id,
          mode: delivery.mode,
          state: 'delivered',
          replayed: true,
        };
      }
      if (delivery.state === 'failed') conflict();

      const consumption = await transaction
        .insertInto('discovery.explore_consumptions')
        .values({
          viewer_user_id: delivery.viewer_user_id,
          target_user_id: delivery.target_user_id,
          reason: 'preview',
          consumed_at: generated.processedAt,
        })
        .onConflict((onConflict) => onConflict.doNothing())
        .returning('viewer_user_id')
        .executeTakeFirst();
      let guestCount: number | undefined;
      if (delivery.mode === 'guest_preview') {
        const counter = await transaction
          .updateTable('identity.guest_preview_counters')
          .set({
            preview_count: sql<number>`preview_count + 1`,
            first_preview_at: sql<Date>`LEAST(COALESCE(first_preview_at, ${generated.processedAt}), ${generated.processedAt})`,
            last_preview_at: sql<Date>`GREATEST(COALESCE(last_preview_at, ${generated.processedAt}), ${generated.processedAt})`,
          })
          .where('user_id', '=', delivery.viewer_user_id)
          .where((expression) => expression('preview_count', '<', expression.ref('limit_count')))
          .returning('preview_count')
          .executeTakeFirst();
        if (counter === undefined)
          throw new ApplicationError(
            'guest_preview_limit_reached',
            'error.guest_preview.limit_reached',
            409,
          );
        guestCount = counter.preview_count;
      }
      const delivered = await transaction
        .updateTable('discovery.candidate_deliveries')
        .set({
          state: 'delivered',
          attempt_count: sql<number>`attempt_count + 1`,
          provider_message_id: input.providerMessageId,
          delivered_at: generated.processedAt,
          updated_at: generated.processedAt,
        })
        .where('id', '=', delivery.id)
        .where('state', '=', 'reserved')
        .returning('id')
        .executeTakeFirst();
      if (delivered === undefined) conflict();
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: generated.auditId,
          category: 'product',
          event_type: 'discovery.candidate-delivered.v1',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'candidate_delivery',
          subject_id: delivery.id,
          result_code: 'delivered',
          metadata_schema_version: 1,
          metadata: {
            mode: delivery.mode,
            consumptionCreated: consumption !== undefined,
            ...(guestCount === undefined ? {} : { guestPreviewCount: guestCount }),
          },
          request_id: delivery.id,
          command_id: delivery.id,
          occurred_at: generated.processedAt,
        })
        .execute();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: generated.deliveryEventId,
          aggregate_type: 'candidate_delivery',
          aggregate_id: delivery.id,
          event_type: 'discovery.candidate-delivered.v1',
          schema_version: 1,
          payload: {
            deliveryId: delivery.id,
            viewerUserId: delivery.viewer_user_id,
            targetUserId: delivery.target_user_id,
            mode: delivery.mode,
          },
          occurred_at: generated.processedAt,
          available_at: generated.processedAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: delivery.id,
          causation_id: delivery.id,
        })
        .execute();
      if (consumption !== undefined)
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: generated.consumptionEventId,
            aggregate_type: 'explore_consumption',
            aggregate_id: delivery.id,
            event_type: 'discovery.consumption-created.v1',
            schema_version: 1,
            payload: {
              viewerUserId: delivery.viewer_user_id,
              targetUserId: delivery.target_user_id,
              reason: 'preview',
            },
            occurred_at: generated.processedAt,
            available_at: generated.processedAt,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: delivery.id,
            causation_id: delivery.id,
          })
          .execute();
      return { deliveryId: delivery.id, mode: delivery.mode, state: 'delivered', replayed: false };
    });
  }

  public recordDefinitiveFailure(
    input: Readonly<{ deliveryId: string; reasonCode: string }>,
    generated: FailedGenerated,
  ): Promise<CandidateDeliveryResult> {
    return this.database.transaction().execute(async (transaction) => {
      const delivery = await transaction
        .selectFrom('discovery.candidate_deliveries')
        .selectAll()
        .where('id', '=', input.deliveryId)
        .forUpdate()
        .executeTakeFirst();
      if (delivery === undefined) notFound();
      if (delivery.state === 'failed')
        return { deliveryId: delivery.id, mode: delivery.mode, state: 'failed', replayed: true };
      if (delivery.state === 'delivered') conflict();
      const failed = await transaction
        .updateTable('discovery.candidate_deliveries')
        .set({
          state: 'failed',
          attempt_count: sql<number>`attempt_count + 1`,
          failed_at: generated.processedAt,
          updated_at: generated.processedAt,
        })
        .where('id', '=', delivery.id)
        .where('state', '=', 'reserved')
        .returning('id')
        .executeTakeFirst();
      if (failed === undefined) conflict();
      await transaction
        .insertInto('platform.audit_logs')
        .values({
          id: generated.auditId,
          category: 'product',
          event_type: 'discovery.candidate-delivery-failed.v1',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          subject_type: 'candidate_delivery',
          subject_id: delivery.id,
          result_code: input.reasonCode,
          metadata_schema_version: 1,
          metadata: { mode: delivery.mode, reasonCode: input.reasonCode },
          request_id: delivery.id,
          command_id: delivery.id,
          occurred_at: generated.processedAt,
        })
        .execute();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: generated.eventId,
          aggregate_type: 'candidate_delivery',
          aggregate_id: delivery.id,
          event_type: 'discovery.candidate-delivery-failed.v1',
          schema_version: 1,
          payload: {
            deliveryId: delivery.id,
            viewerUserId: delivery.viewer_user_id,
            targetUserId: delivery.target_user_id,
            mode: delivery.mode,
            reasonCode: input.reasonCode,
          },
          occurred_at: generated.processedAt,
          available_at: generated.processedAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: delivery.id,
          causation_id: delivery.id,
        })
        .execute();
      return { deliveryId: delivery.id, mode: delivery.mode, state: 'failed', replayed: false };
    });
  }
}
