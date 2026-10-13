import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { DomainEvent } from '@nakh/contracts';
import { DOMAIN_EVENT_QUEUE, type QueuedEventReference } from './index.js';

export interface QueueReferenceMigrationAudit {
  prepare(queueHash: string, reference: QueuedEventReference, legacy: DomainEvent): Promise<string>;
  observe(
    auditId: string,
    outcome: 'normalized' | 'already_reference' | 'active' | 'gone' | 'changed',
  ): Promise<void>;
  reconcile(queueHash: string, reference: QueuedEventReference): Promise<void>;
}
export type QueueReferenceMigrationCursor = Readonly<{
  redisCursor: string;
  pendingKeys: readonly string[];
}>;
export type QueueReferenceMigrationBatch = Readonly<{
  normalized: number;
  active: number;
  changed: number;
  nextCursor: QueueReferenceMigrationCursor;
  hasMore: boolean;
}>;

function validCursor(value: unknown, prefix: string): value is QueueReferenceMigrationCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const cursor = value as Readonly<Record<string, unknown>>;
  return (
    typeof cursor.redisCursor === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/u.test(cursor.redisCursor) &&
    Array.isArray(cursor.pendingKeys) &&
    cursor.pendingKeys.length <= 1000 &&
    cursor.pendingKeys.every((key: unknown) => typeof key === 'string' && key.startsWith(prefix))
  );
}

/** Operational format migration, not canonical erasure or deletion completion.
 * Atomic byte/lock comparison never overwrites active or changed job evidence. */
export class BullMqLegacyReferenceMigration {
  private readonly jobPrefix: string;
  private readonly queueHash: string;
  public constructor(
    private readonly redis: Redis,
    prefix: string,
    private readonly audit: QueueReferenceMigrationAudit,
  ) {
    this.jobPrefix = `${prefix}:${DOMAIN_EVENT_QUEUE}:`;
    this.queueHash = createHash('sha256').update(this.jobPrefix).digest('hex');
  }
  public async scanNext(
    cursor: QueueReferenceMigrationCursor = { redisCursor: '0', pendingKeys: [] },
    limit = 100,
  ): Promise<QueueReferenceMigrationBatch> {
    if (
      !validCursor(cursor, this.jobPrefix) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('invalid_queue_migration_batch');
    const page: [string, string[]] =
      cursor.pendingKeys.length > 0
        ? [cursor.redisCursor, [...cursor.pendingKeys]]
        : await this.redis.scan(cursor.redisCursor, 'MATCH', `${this.jobPrefix}*`, 'COUNT', 100);
    if (page[1].length > 1000) throw new Error('queue_migration_page_unavailable');
    const keys = page[1].slice(0, limit);
    let normalized = 0,
      active = 0,
      changed = 0;
    for (const key of keys) {
      if (!key.startsWith(this.jobPrefix)) throw new Error('queue_migration_namespace_conflict');
      if ((await this.redis.type(key)) !== 'hash') continue;
      const raw = await this.redis.hget(key, 'data');
      if (raw === null) continue;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error('invalid_queue_migration_source');
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data))
        throw new Error('invalid_queue_migration_source');
      const candidate = data as Readonly<Record<string, unknown>>;
      const id = key.slice(this.jobPrefix.length);
      if (candidate.kind === 'outbox-reference.v1') {
        if (
          Object.keys(candidate).sort().join(',') !==
            'aggregateId,aggregateType,eventId,eventSchemaVersion,eventType,kind' ||
          candidate.eventId !== id ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id) ||
          typeof candidate.eventType !== 'string' ||
          candidate.eventType.length < 1 ||
          candidate.eventType.length > 160 ||
          candidate.eventType !== (await this.redis.hget(key, 'name')) ||
          !Number.isSafeInteger(candidate.eventSchemaVersion) ||
          (candidate.eventSchemaVersion as number) < 1 ||
          typeof candidate.aggregateType !== 'string' ||
          candidate.aggregateType.length < 1 ||
          candidate.aggregateType.length > 80 ||
          typeof candidate.aggregateId !== 'string' ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(candidate.aggregateId)
        )
          throw new Error('invalid_queue_migration_source');
        await this.audit.reconcile(this.queueHash, candidate as QueuedEventReference);
        continue;
      }
      if (
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id) ||
        candidate.id !== id ||
        Object.keys(candidate).sort().join(',') !==
          'aggregateId,aggregateType,causationId,correlationId,eventType,id,occurredAt,payload,schemaVersion' ||
        typeof candidate.eventType !== 'string' ||
        candidate.eventType.length < 1 ||
        candidate.eventType.length > 160 ||
        candidate.eventType !== (await this.redis.hget(key, 'name')) ||
        typeof candidate.aggregateType !== 'string' ||
        candidate.aggregateType.length < 1 ||
        candidate.aggregateType.length > 80 ||
        typeof candidate.aggregateId !== 'string' ||
        !Number.isSafeInteger(candidate.schemaVersion) ||
        (candidate.schemaVersion as number) < 1 ||
        typeof candidate.occurredAt !== 'string' ||
        !Number.isFinite(Date.parse(candidate.occurredAt)) ||
        typeof candidate.correlationId !== 'string' ||
        typeof candidate.causationId !== 'string' ||
        !['aggregateId', 'correlationId', 'causationId'].every(
          (field) =>
            typeof candidate[field] === 'string' &&
            /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(candidate[field]),
        ) ||
        typeof candidate.payload !== 'object' ||
        candidate.payload === null ||
        Array.isArray(candidate.payload)
      )
        throw new Error('invalid_queue_migration_source');
      if (await this.redis.exists(`${key}:lock`)) {
        active++;
        continue;
      }
      const legacy = candidate as DomainEvent;
      const reference: QueuedEventReference = {
        kind: 'outbox-reference.v1',
        eventId: id,
        eventType: legacy.eventType,
        eventSchemaVersion: legacy.schemaVersion,
        aggregateType: legacy.aggregateType,
        aggregateId: legacy.aggregateId,
      };
      const auditId = await this.audit.prepare(this.queueHash, reference, legacy);
      const encoded = JSON.stringify(reference);
      const result = await this.redis.eval(
        `
        if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
        local current = redis.call('HGET', KEYS[1], 'data')
        if not current then return 3 end
        if current == ARGV[2] then return 0 end
        if current ~= ARGV[1] then return 4 end
        redis.call('HSET', KEYS[1], 'data', ARGV[2])
        return 1
      `,
        2,
        key,
        `${key}:lock`,
        raw,
        encoded,
      );
      const outcomes = ['already_reference', 'normalized', 'active', 'gone', 'changed'] as const;
      if (
        typeof result !== 'number' ||
        !Number.isInteger(result) ||
        result < 0 ||
        result >= outcomes.length
      )
        throw new Error('queue_migration_observation_unavailable');
      await this.audit.observe(auditId, outcomes[result]!);
      if (result === 1) normalized++;
      if (result === 2) active++;
      if (result === 4) changed++;
    }
    // COUNT is advisory. Persist the unexamined metadata keys instead of losing
    // them or repeatedly restarting a page whose normalized keys still exist.
    const nextCursor = { redisCursor: page[0], pendingKeys: page[1].slice(limit) };
    return {
      normalized,
      active,
      changed,
      nextCursor,
      hasMore:
        nextCursor.redisCursor !== '0' ||
        nextCursor.pendingKeys.length > 0 ||
        active > 0 ||
        changed > 0,
    };
  }
}
