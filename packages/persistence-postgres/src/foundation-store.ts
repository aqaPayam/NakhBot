import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'kysely';

import type {
  CreateSampleEffectCommand,
  CreateSampleEffectResult,
  DomainEvent,
} from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';
import type { CreateSampleEffectWrite, FoundationStore } from '@nakh/application';

import type { NakhDatabase } from './database.js';

function requestHash(command: CreateSampleEffectCommand): string {
  const canonical = JSON.stringify({
    commandType: command.commandType,
    schemaVersion: command.schemaVersion,
    actor: command.actor,
    data: command.data,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function parseStoredResult(value: Readonly<Record<string, unknown>>): CreateSampleEffectResult {
  return {
    effectId: String(value.effectId),
    eventId: String(value.eventId),
    name: String(value.name),
    createdAt: String(value.createdAt),
    replayed: true,
  };
}

export class SystemIdGenerator implements IdGenerator {
  public uuid(): string {
    return randomUUID();
  }
}

export class PostgresFoundationStore implements FoundationStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async createSampleEffect(
    write: CreateSampleEffectWrite,
  ): Promise<CreateSampleEffectResult> {
    const hash = requestHash(write.command);
    const createdAt = write.createdAt.toISOString();
    return this.database.transaction().execute(async (transaction) => {
      const claimed = await transaction
        .insertInto('platform.idempotency_records')
        .values({
          id: write.command.commandId,
          actor_user_id: write.command.actor.userId,
          scope: write.command.commandType,
          idempotency_key: write.command.idempotencyKey,
          request_hash: hash,
          status: 'processing',
          response_json: null,
          expires_at: new Date(write.createdAt.getTime() + 24 * 60 * 60 * 1_000),
          created_at: write.createdAt,
          updated_at: write.createdAt,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning('id')
        .executeTakeFirst();

      if (claimed === undefined) {
        const existing = await transaction
          .selectFrom('platform.idempotency_records')
          .select(['request_hash', 'status', 'response_json'])
          .where('actor_user_id', '=', write.command.actor.userId)
          .where('scope', '=', write.command.commandType)
          .where('idempotency_key', '=', write.command.idempotencyKey)
          .executeTakeFirstOrThrow();

        if (existing.request_hash !== hash) {
          throw new ApplicationError(
            'idempotency_conflict',
            'The idempotency key was already used for a different request.',
            409,
          );
        }
        if (existing.status !== 'completed' || existing.response_json === null) {
          throw new ApplicationError(
            'conflict',
            'The original command is still being processed.',
            409,
          );
        }
        return parseStoredResult(existing.response_json);
      }

      const result: CreateSampleEffectResult = {
        effectId: write.effectId,
        eventId: write.eventId,
        name: write.command.data.name,
        createdAt,
        replayed: false,
      };
      await transaction
        .insertInto('platform.sample_effects')
        .values({
          id: write.effectId,
          actor_user_id: write.command.actor.userId,
          name: write.command.data.name,
          created_at: write.createdAt,
        })
        .execute();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'sample_effect',
          aggregate_id: write.effectId,
          event_type: 'platform.sample-effect-created.v1',
          schema_version: 1,
          payload: { effectId: write.effectId, name: write.command.data.name },
          occurred_at: write.createdAt,
          available_at: write.createdAt,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: write.command.requestId,
          causation_id: write.command.commandId,
        })
        .execute();
      await transaction
        .updateTable('platform.idempotency_records')
        .set({ status: 'completed', response_json: result, updated_at: write.createdAt })
        .where('id', '=', write.command.commandId)
        .executeTakeFirstOrThrow();

      return result;
    });
  }
}

export type ClaimedOutboxEvent = DomainEvent;

export class PostgresOutboxStore {
  public constructor(private readonly database: NakhDatabase) {}

  /** Queue references carry no event bodies. Legacy bodies must equal canonical
   * immutable facts before normalization; financial/custody work is preserved. */
  public async resolveQueuedEvent(
    reference: Readonly<{
      eventId: string;
      eventType: string;
      eventSchemaVersion: number;
      aggregateType: string;
      aggregateId: string;
    }>,
    legacy?: DomainEvent,
  ): Promise<DomainEvent | undefined> {
    const row = await this.database
      .selectFrom('platform.outbox_events')
      .selectAll()
      .where('id', '=', reference.eventId)
      .executeTakeFirst();
    const isSample =
      reference.eventType === 'platform.sample-effect-created.v1' &&
      reference.eventSchemaVersion === 1 &&
      reference.aggregateType === 'sample_effect';
    if (
      isSample &&
      legacy !== undefined &&
      (Object.keys(legacy.payload).sort().join(',') !== 'effectId,name' ||
        legacy.payload.effectId !== reference.aggregateId ||
        typeof legacy.payload.name !== 'string')
    )
      throw new Error('queued_event_source_conflict');
    if (row === undefined) {
      if (isSample) {
        const proven = (
          await sql<{ proven: boolean }>`SELECT EXISTS(
          SELECT 1 FROM platform.sample_reference_anchors original
          JOIN identity.account_deletion_sample_receipts receipt ON receipt.source_id=original.id
          WHERE original.id=${reference.aggregateId}::uuid
            AND platform.sample_purge_proven(receipt.deletion_record_id,original.id)
            AND (${legacy === undefined}::boolean OR original.name_digest=${
              legacy === undefined
                ? ''
                : createHash('sha256').update(String(legacy.payload.name)).digest('hex')
            })
        ) AS proven`.execute(this.database)
        ).rows[0]!.proven;
        if (proven) return undefined;
      }
      throw new Error('queued_event_source_unavailable');
    }
    if (
      row.event_type !== reference.eventType ||
      row.schema_version !== reference.eventSchemaVersion ||
      row.aggregate_type !== reference.aggregateType ||
      row.aggregate_id !== reference.aggregateId
    )
      throw new Error('queued_event_source_conflict');
    const canonical: DomainEvent = {
      id: row.id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      occurredAt: row.occurred_at.toISOString(),
      correlationId: row.correlation_id,
      causationId: row.causation_id,
    };
    if (legacy !== undefined && !isDeepStrictEqual(legacy, canonical))
      throw new Error('queued_event_source_conflict');
    if (row.deletion_cancellation_audit_id !== null) {
      const valid = (
        await sql<{ valid: boolean }>`SELECT platform.deletion_cancellation_audit_valid(
        ${row.deletion_cancellation_audit_id}::uuid) AS valid`.execute(this.database)
      ).rows[0]!.valid;
      if (!valid) throw new Error('queued_event_source_conflict');
      return undefined;
    }
    if (isSample) {
      const source = (
        await sql<{ valid: boolean; deleted: boolean }>`SELECT
        source.actor_user_id=original.actor_user_id AND original.name_digest=encode(sha256(convert_to(source.name,'UTF8')),'hex')
          AND ${JSON.stringify(row.payload)}::jsonb=jsonb_build_object('effectId',source.id,'name',source.name)
          AND ((account.user_id IS NULL AND original.product_epoch IS NULL)
            OR account.product_epoch=original.product_epoch) AS valid,
        account.state='deleted' AS deleted
        FROM platform.sample_effects source JOIN platform.sample_reference_anchors original ON original.id=source.id
        LEFT JOIN identity.accounts account ON account.user_id=original.actor_user_id
        WHERE source.id=${row.aggregate_id}::uuid`.execute(this.database)
      ).rows[0];
      if (source === undefined || !source.valid) throw new Error('queued_event_source_conflict');
      if (source.deleted) return undefined;
    }
    return canonical;
  }

  public async claimBatch(
    input: Readonly<{
      owner: string;
      now: Date;
      leaseMs: number;
      limit: number;
      eventTypes?: readonly string[];
    }>,
  ): Promise<ClaimedOutboxEvent[]> {
    const leaseExpiry = new Date(input.now.getTime() + input.leaseMs);
    return this.database.transaction().execute(async (transaction) => {
      let candidateQuery = transaction
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('published_at', 'is', null)
        .where('deletion_cancellation_audit_id', 'is', null)
        .where('available_at', '<=', input.now)
        .where((expression) =>
          expression.or([
            expression('lease_expires_at', 'is', null),
            expression('lease_expires_at', '<', input.now),
          ]),
        )
        .orderBy('available_at', 'asc')
        .orderBy('id', 'asc')
        .limit(input.limit);
      if (input.eventTypes !== undefined && input.eventTypes.length > 0) {
        candidateQuery = candidateQuery.where('event_type', 'in', input.eventTypes);
      }
      const candidates = await candidateQuery.forUpdate().skipLocked().execute();
      const ids = candidates.map(({ id }) => id);
      if (ids.length === 0) return [];

      const rows = await transaction
        .updateTable('platform.outbox_events')
        .set((expression) => ({
          lease_owner: input.owner,
          lease_expires_at: leaseExpiry,
          attempt_count: expression('attempt_count', '+', 1),
        }))
        .where('id', 'in', ids)
        .returningAll()
        .execute();

      return rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        occurredAt: row.occurred_at.toISOString(),
        correlationId: row.correlation_id,
        causationId: row.causation_id,
      }));
    });
  }

  public async markPublished(id: string, owner: string, at: Date): Promise<void> {
    const result = await this.database
      .updateTable('platform.outbox_events')
      .set({ published_at: at, lease_owner: null, lease_expires_at: null, last_error_code: null })
      .where('id', '=', id)
      .where('lease_owner', '=', owner)
      .where('published_at', 'is', null)
      .where('deletion_cancellation_audit_id', 'is', null)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n)
      throw new Error('Outbox lease was lost before publish marking.');
  }

  public async release(
    id: string,
    owner: string,
    errorCode: string,
    availableAt: Date,
  ): Promise<void> {
    await this.database
      .updateTable('platform.outbox_events')
      .set({
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: errorCode,
        available_at: availableAt,
      })
      .where('id', '=', id)
      .where('lease_owner', '=', owner)
      .where('deletion_cancellation_audit_id', 'is', null)
      .execute();
  }
}

export type InboxProcessingHooks = Readonly<{
  afterProjection?: () => void | Promise<void>;
}>;

export class PostgresInboxStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly ids: IdGenerator,
  ) {}

  public async processSampleEvent(
    event: DomainEvent,
    hooks: InboxProcessingHooks = {},
  ): Promise<'processed' | 'duplicate'> {
    const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    return this.database.transaction().execute(async (transaction) => {
      const receivedAt = new Date();
      const claim = await transaction
        .insertInto('platform.inbox_messages')
        .values({
          id: this.ids.uuid(),
          consumer: 'sample-projector.v1',
          message_id: event.id,
          payload_hash: hash,
          received_at: receivedAt,
          processed_at: null,
          result_code: null,
        })
        .onConflict((conflict) => conflict.columns(['consumer', 'message_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (claim === undefined) return 'duplicate';

      if (event.eventType !== 'platform.sample-effect-created.v1') {
        throw new ApplicationError('invalid_request', 'Unsupported event type.', 400);
      }
      const effectId = String(event.payload.effectId);
      const name = String(event.payload.name);
      await transaction
        .insertInto('platform.sample_projections')
        .values({
          id: this.ids.uuid(),
          source_event_id: event.id,
          effect_id: effectId,
          projected_name: name,
          projected_at: receivedAt,
        })
        .execute();

      await hooks.afterProjection?.();

      await transaction
        .updateTable('platform.inbox_messages')
        .set({ processed_at: new Date(), result_code: 'processed' })
        .where('id', '=', claim.id)
        .executeTakeFirstOrThrow();
      return 'processed';
    });
  }
}
