import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { DomainEvent } from '@nakh/contracts';
import type { NakhDatabase } from './database.js';
import { PostgresOutboxStore } from './foundation-store.js';

type Reference = Readonly<{
  kind: 'outbox-reference.v1';
  eventId: string;
  eventType: string;
  eventSchemaVersion: number;
  aggregateType: string;
  aggregateId: string;
}>;
type Outcome = 'normalized' | 'already_reference' | 'active' | 'gone' | 'changed';
function referenceHash(reference: Reference): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: reference.kind,
        eventId: reference.eventId,
        eventType: reference.eventType,
        eventSchemaVersion: reference.eventSchemaVersion,
        aggregateType: reference.aggregateType,
        aggregateId: reference.aggregateId,
      }),
    )
    .digest('hex');
}

/** Append-only system format-migration authority; no event bodies enter audits.
 * Canonical financial/safety records are never changed by this store. */
export class PostgresQueueReferenceMigrationAudit {
  public constructor(private readonly database: NakhDatabase) {}
  public async prepare(
    queueHash: string,
    reference: Reference,
    legacy: DomainEvent,
  ): Promise<string> {
    if (!/^[0-9a-f]{64}$/u.test(queueHash) || reference.eventId !== legacy.id)
      throw new Error('queue_migration_authority_unavailable');
    try {
      return await this.database.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'queue-reference:' + queueHash + ':' + reference.eventId},0))`.execute(
          tx,
        );
        await new PostgresOutboxStore(tx).resolveQueuedEvent(reference, legacy);
        const bodyHash = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
        const fingerprint = referenceHash(reference);
        const existing = await tx
          .selectFrom('platform.audit_logs')
          .select(['id', 'metadata'])
          .where('event_type', '=', 'queue.legacy-reference-prepared.v1')
          .where('category', '=', 'security')
          .where('actor_type', '=', 'system')
          .where('actor_user_id', 'is', null)
          .where('actor_admin_id', 'is', null)
          .where('result_code', '=', 'reference_migration_prepared')
          .where('metadata_schema_version', '=', 1)
          .where('subject_type', '=', 'queue_job')
          .where('subject_id', '=', reference.eventId)
          .orderBy('occurred_at', 'desc')
          .execute();
        const same = existing.find(
          (row) =>
            Object.keys(row.metadata).sort().join(',') === 'bodyHash,queueHash,referenceHash' &&
            row.metadata.queueHash === queueHash &&
            row.metadata.bodyHash === bodyHash &&
            row.metadata.referenceHash === fingerprint,
        );
        if (same !== undefined) return same.id;
        const id = randomUUID();
        const written = await tx
          .insertInto('platform.audit_logs')
          .values({
            id,
            category: 'security',
            event_type: 'queue.legacy-reference-prepared.v1',
            actor_type: 'system',
            actor_user_id: null,
            actor_admin_id: null,
            subject_type: 'queue_job',
            subject_id: reference.eventId,
            result_code: 'reference_migration_prepared',
            metadata_schema_version: 1,
            metadata: { queueHash, bodyHash, referenceHash: fingerprint },
            request_id: randomUUID(),
            command_id: randomUUID(),
            occurred_at: new Date(),
          })
          .returning('id')
          .execute();
        if (written.length !== 1) throw new Error('queue_migration_authority_unavailable');
        return id;
      });
    } catch {
      throw new Error('queue_migration_authority_unavailable');
    }
  }
  public async observe(auditId: string, outcome: Outcome): Promise<void> {
    if (!['normalized', 'already_reference', 'active', 'gone', 'changed'].includes(outcome))
      throw new Error('queue_migration_observation_unavailable');
    try {
      await this.database.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'queue-reference-observation:' + auditId},0))`.execute(
          tx,
        );
        const prepared = await tx
          .selectFrom('platform.audit_logs')
          .selectAll()
          .where('id', '=', auditId)
          .executeTakeFirst();
        if (
          prepared === undefined ||
          prepared.event_type !== 'queue.legacy-reference-prepared.v1' ||
          prepared.subject_type !== 'queue_job' ||
          prepared.actor_type !== 'system' ||
          prepared.actor_user_id !== null ||
          prepared.actor_admin_id !== null ||
          prepared.category !== 'security' ||
          prepared.metadata_schema_version !== 1 ||
          prepared.result_code !== 'reference_migration_prepared' ||
          Object.keys(prepared.metadata).sort().join(',') !== 'bodyHash,queueHash,referenceHash' ||
          !['queueHash', 'bodyHash', 'referenceHash'].every(
            (key) =>
              typeof prepared.metadata[key] === 'string' &&
              /^[0-9a-f]{64}$/u.test(prepared.metadata[key]),
          )
        )
          throw new Error('queue_migration_observation_unavailable');
        const existing = await tx
          .selectFrom('platform.audit_logs')
          .select('metadata')
          .where('event_type', '=', 'queue.legacy-reference-observed.v1')
          .where('subject_type', '=', 'queue_job')
          .where('category', '=', 'security')
          .where('actor_type', '=', 'system')
          .where('actor_user_id', 'is', null)
          .where('actor_admin_id', 'is', null)
          .where('metadata_schema_version', '=', 1)
          .where('result_code', '=', 'reference_migration_observed')
          .where('subject_id', '=', prepared.subject_id)
          .execute();
        if (
          existing.some(
            (row) =>
              Object.keys(row.metadata).sort().join(',') ===
                'outcome,preparedAuditId,queueHash,referenceHash' &&
              row.metadata.preparedAuditId === auditId &&
              row.metadata.outcome === outcome &&
              row.metadata.queueHash === prepared.metadata.queueHash &&
              row.metadata.referenceHash === prepared.metadata.referenceHash,
          )
        )
          return;
        const written = await tx
          .insertInto('platform.audit_logs')
          .values({
            id: randomUUID(),
            category: 'security',
            event_type: 'queue.legacy-reference-observed.v1',
            actor_type: 'system',
            actor_user_id: null,
            actor_admin_id: null,
            subject_type: 'queue_job',
            subject_id: prepared.subject_id,
            result_code: 'reference_migration_observed',
            metadata_schema_version: 1,
            metadata: {
              preparedAuditId: auditId,
              outcome,
              queueHash: prepared.metadata.queueHash,
              referenceHash: prepared.metadata.referenceHash,
            },
            request_id: prepared.request_id,
            command_id: prepared.command_id,
            occurred_at: new Date(),
          })
          .returning('id')
          .execute();
        if (written.length !== 1) throw new Error('queue_migration_observation_unavailable');
      });
    } catch {
      throw new Error('queue_migration_observation_unavailable');
    }
  }
  public async reconcile(queueHash: string, reference: Reference): Promise<void> {
    const fingerprint = referenceHash(reference);
    const prepared = await this.database
      .selectFrom('platform.audit_logs')
      .select(['id', 'metadata'])
      .where('event_type', '=', 'queue.legacy-reference-prepared.v1')
      .where('subject_type', '=', 'queue_job')
      .where('subject_id', '=', reference.eventId)
      .execute();
    for (const row of prepared)
      if (row.metadata.queueHash === queueHash && row.metadata.referenceHash === fingerprint)
        await this.observe(row.id, 'already_reference');
  }
}
