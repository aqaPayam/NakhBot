import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

import type {
  OpaqueTokenStore,
  UserOpaqueTokenStores,
  UserProductLife,
  OutboxPublisher,
  RateLimiterPort,
  RateLimitRequest,
} from '@nakh/application';
import type { DomainEvent } from '@nakh/contracts';

export const DOMAIN_EVENT_QUEUE = 'domain-events';
export {
  BullMqLegacyReferenceMigration,
  type QueueReferenceMigrationAudit,
  type QueueReferenceMigrationBatch,
  type QueueReferenceMigrationCursor,
} from './legacy-reference-migration.js';
export { RedisLegacyOpaqueStateRetirement } from './legacy-opaque-state-retirement.js';

export type QueuedEventReference = Readonly<{
  kind: 'outbox-reference.v1';
  eventId: string;
  eventType: string;
  eventSchemaVersion: number;
  aggregateType: string;
  aggregateId: string;
}>;
export type QueuedEventHydrator = (
  reference: QueuedEventReference,
  legacy?: DomainEvent,
) => Promise<DomainEvent | undefined>;
type QueuedEvent = DomainEvent | QueuedEventReference;

function validateQueuedDomainEvent(value: unknown): asserts value is DomainEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid_queued_event');
  const event = value as Readonly<Record<string, unknown>>;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
  if (
    Object.keys(event).sort().join(',') !==
      'aggregateId,aggregateType,causationId,correlationId,eventType,id,occurredAt,payload,schemaVersion' ||
    !['id', 'aggregateId', 'correlationId', 'causationId'].every(
      (key) => typeof event[key] === 'string' && uuid.test(event[key]),
    ) ||
    typeof event.eventType !== 'string' ||
    event.eventType.length < 1 ||
    event.eventType.length > 160 ||
    typeof event.aggregateType !== 'string' ||
    event.aggregateType.length < 1 ||
    event.aggregateType.length > 80 ||
    !Number.isSafeInteger(event.schemaVersion) ||
    (event.schemaVersion as number) < 1 ||
    typeof event.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/iu.test(
      event.occurredAt,
    ) ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  )
    throw new Error('invalid_queued_event');
}

export function createRedisConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
}

export class BullMqOutboxPublisher implements OutboxPublisher {
  private readonly queue: Queue<QueuedEvent>;

  public constructor(
    connection: Redis,
    prefix: string,
    private readonly referenceOnly = false,
  ) {
    this.queue = new Queue<QueuedEvent>(DOMAIN_EVENT_QUEUE, { connection, prefix });
  }

  public async publish(event: DomainEvent): Promise<void> {
    const options: JobsOptions = {
      jobId: event.id,
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
      removeOnFail: false,
      stackTraceLimit: 0,
    };
    validateQueuedDomainEvent(event);
    const data: QueuedEvent = this.referenceOnly
      ? {
          kind: 'outbox-reference.v1',
          eventId: event.id,
          eventType: event.eventType,
          eventSchemaVersion: event.schemaVersion,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
        }
      : event;
    await this.queue.add(event.eventType, data, options);
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}

/** Do not persist provider/SQL text or causes in BullMQ diagnostics. */
function sanitizedQueueFailure(error: unknown): Error {
  const allowed = new Set(['invalid_queued_event', 'invalid_queued_event_reference']);
  return new Error(
    error instanceof Error && allowed.has(error.message)
      ? error.message
      : 'domain_event_processing_failed',
  );
}

export function createDomainEventWorker(
  connection: Redis,
  prefix: string,
  processor: (event: DomainEvent) => Promise<void>,
  hydrate?: QueuedEventHydrator,
): Worker<QueuedEvent> {
  return new Worker<QueuedEvent>(
    DOMAIN_EVENT_QUEUE,
    async (job) => {
      job.opts.stackTraceLimit = 0;
      try {
        const data: unknown = job.data;
        if (typeof data !== 'object' || data === null || Array.isArray(data))
          throw new Error('invalid_queued_event');
        const candidate = data as Readonly<Record<string, unknown>>;
        let event: DomainEvent | undefined;
        let normalize: QueuedEventReference | undefined;
        let legacyBody: DomainEvent | undefined;
        if (candidate.kind === 'outbox-reference.v1') {
          if (
            Object.keys(candidate).sort().join(',') !==
              'aggregateId,aggregateType,eventId,eventSchemaVersion,eventType,kind' ||
            typeof candidate.eventId !== 'string' ||
            candidate.eventId !== job.id ||
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(candidate.eventId) ||
            typeof candidate.eventType !== 'string' ||
            candidate.eventType !== job.name ||
            typeof candidate.aggregateType !== 'string' ||
            candidate.aggregateType.length < 1 ||
            candidate.aggregateType.length > 80 ||
            typeof candidate.aggregateId !== 'string' ||
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(candidate.aggregateId) ||
            !Number.isSafeInteger(candidate.eventSchemaVersion) ||
            (candidate.eventSchemaVersion as number) < 1 ||
            hydrate === undefined
          )
            throw new Error('invalid_queued_event_reference');
          event = await hydrate(candidate as QueuedEventReference);
        } else {
          validateQueuedDomainEvent(data);
          const legacy = data;
          if (legacy.id !== job.id || legacy.eventType !== job.name)
            throw new Error('invalid_queued_event');
          const reference: QueuedEventReference = {
            kind: 'outbox-reference.v1',
            eventId: legacy.id,
            eventType: legacy.eventType,
            eventSchemaVersion: legacy.schemaVersion,
            aggregateType: legacy.aggregateType,
            aggregateId: legacy.aggregateId,
          };
          event = hydrate === undefined ? legacy : await hydrate(reference, legacy);
          if (hydrate !== undefined) {
            normalize = reference;
            legacyBody = legacy;
          }
        }
        if (event !== undefined) {
          validateQueuedDomainEvent(event);
          if (
            event.id !== job.id ||
            event.eventType !== job.name ||
            event.aggregateType !== candidate.aggregateType ||
            event.aggregateId !== candidate.aggregateId ||
            event.schemaVersion !== (candidate.eventSchemaVersion ?? candidate.schemaVersion)
          )
            throw new Error('invalid_queued_event');
          if (legacyBody !== undefined && !isDeepStrictEqual(legacyBody, event))
            throw new Error('invalid_queued_event');
        }
        if (normalize !== undefined) await job.updateData(normalize);
        if (event !== undefined) await processor(event);
      } catch (error) {
        throw sanitizedQueueFailure(error);
      }
    },
    {
      connection,
      prefix,
      concurrency: 20,
    },
  );
}

export class RedisLease {
  public constructor(private readonly redis: Redis) {}

  public async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, owner, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  public async release(key: string, owner: string): Promise<boolean> {
    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      end
      return 0
    `;
    return (await this.redis.eval(script, 1, key, owner)) === 1;
  }
}

export class RedisRateLimiter implements RateLimiterPort {
  public constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  public async consume(request: RateLimitRequest): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
  }> {
    const subjectHash = createHash('sha256').update(request.subject).digest('hex');
    const key = `${this.prefix}:rate:${request.scope}:${subjectHash}`;
    const script = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      local ttl = redis.call('TTL', KEYS[1])
      return {current, ttl}
    `;
    const raw = await this.redis.eval(script, 1, key, request.windowSeconds);
    if (!Array.isArray(raw) || typeof raw[0] !== 'number' || typeof raw[1] !== 'number')
      throw new Error('Redis rate-limit script returned an invalid result.');
    return {
      allowed: raw[0] <= request.limit,
      remaining: Math.max(0, request.limit - raw[0]),
      retryAfterSeconds: Math.max(0, raw[1]),
    };
  }
}

type OpaqueStatePolicy = Readonly<{ maxBytes: number; maxLifetime: number; internal: boolean }>;
const MUTATION_PURPOSE =
  '(?:support|appeal-review|appeal-unban|report-assignment|report-decision|report-account|report-photo|report-evidence|report-block)';
const MUTATION_KEY = new RegExp(
  `^telegram-admin-${MUTATION_PURPOSE}-mutation:[A-Za-z0-9_-]{22}$`,
  'u',
);
const MUTATION_DECISION_KEY = new RegExp(
  `^telegram-admin-${MUTATION_PURPOSE}-mutation-decision:[A-Za-z0-9_-]{22}$`,
  'u',
);

/** Logical keys are allocated by existing server-owned token/receipt producers.
 * Public token parsers still own their strict opaque reference formats. */
function opaqueStatePolicy(id: string): OpaqueStatePolicy | undefined {
  if (id.length > 128) return undefined;
  if (/^[A-Za-z0-9_-]{16}$/u.test(id))
    return { maxBytes: 4096, maxLifetime: 86400, internal: false };
  if (
    /^telegram-report:[A-Za-z0-9_-]{22}$/u.test(id) ||
    /^telegram-admin-rejection:delivered:[A-Za-z0-9_-]{43}$/u.test(id)
  )
    return { maxBytes: 4096, maxLifetime: 86400, internal: true };
  if (/^telegram-admin-safety-read:[A-Za-z0-9_-]{22}$/u.test(id))
    return { maxBytes: 16384, maxLifetime: 300, internal: true };
  if (MUTATION_KEY.test(id)) return { maxBytes: 32768, maxLifetime: 300, internal: true };
  if (
    MUTATION_DECISION_KEY.test(id) ||
    /^telegram-admin-safety-read-withdrawn:[A-Za-z0-9_-]{22}$/u.test(id) ||
    /^telegram-admin-queue:(?:choice|page|prompt):[A-Za-z0-9_-]{22}$/u.test(id) ||
    /^telegram-admin-report-queue:(?:choice|page|prompt|evidence|photo-prompt|evidence-prompt|block-prompt):[A-Za-z0-9_-]{22}$/u.test(
      id,
    ) ||
    /^telegram-admin-target-selection:[A-Za-z0-9_-]{43}$/u.test(id) ||
    /^telegram-admin-rejection:pending:[A-Za-z0-9_-]{43}$/u.test(id)
  )
    return { maxBytes: 4096, maxLifetime: 300, internal: true };
  return undefined;
}

export class RedisOpaqueTokenStore implements OpaqueTokenStore {
  public constructor(
    protected readonly redis: Redis,
    protected readonly prefix: string,
    private readonly namespaceVersion: 1 | 2 = 2,
  ) {
    if (namespaceVersion !== 1 && namespaceVersion !== 2)
      throw new Error('Opaque token namespace is invalid.');
  }

  protected key(id: string, policy: OpaqueStatePolicy): string {
    // Current unowned administration/UI references cannot recreate retired v1
    // bodies. User product references must use the owning lifetime store below.
    const namespace = this.namespaceVersion === 1 ? 'action' : 'action-v2';
    return policy.internal
      ? `${this.prefix}:${namespace}:internal:${createHash('sha256').update(id).digest('hex')}`
      : `${this.prefix}:${namespace}:${id}`;
  }

  public async putIfAbsent(id: string, value: string, ttlSeconds: number): Promise<boolean> {
    const policy = opaqueStatePolicy(id);
    if (
      policy === undefined ||
      value.length < 1 ||
      Buffer.byteLength(value, 'utf8') > policy.maxBytes
    )
      throw new Error('Opaque token state is invalid.');
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > policy.maxLifetime)
      throw new Error('Opaque token lifetime is invalid.');
    if (this.namespaceVersion === 2)
      return (await this.redis.set(this.key(id, policy), value, 'EX', ttlSeconds, 'NX')) === 'OK';
    const result = await this.redis.eval(
      `if redis.call('EXISTS', KEYS[1]) ~= 0 then return -1 end
       if redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2], 'NX') then return 1 end
       return 0`,
      2,
      `${this.prefix}:legacy-action-retired`,
      this.key(id, policy),
      value,
      ttlSeconds,
    );
    if (result !== 0 && result !== 1) throw new Error('Legacy opaque token state is unavailable.');
    return result === 1;
  }

  public async get(id: string): Promise<string | undefined> {
    const policy = opaqueStatePolicy(id);
    if (policy === undefined) return undefined;
    const value =
      this.namespaceVersion === 2
        ? await this.redis.get(this.key(id, policy))
        : await this.redis.eval(
            `if redis.call('EXISTS', KEYS[1]) ~= 0 then return nil end
         return redis.call('GET', KEYS[2])`,
            2,
            `${this.prefix}:legacy-action-retired`,
            this.key(id, policy),
          );
    return typeof value !== 'string' ||
      value.length < 1 ||
      Buffer.byteLength(value, 'utf8') > policy.maxBytes
      ? undefined
      : value;
  }
}

export type OpaqueStateLife = Readonly<{ userId: string; productEpoch: number }>;
export type OpaqueStateRevocationBatch = Readonly<{
  removed: number;
  hasMore: boolean;
  nextCursor: string;
}>;

/** A native owning caller supplies the original account life. Revocation is
 * permanent until separately verified fresh-return composition authorizes it.
 * Existing unscoped keys require migration/composition before phase completion. */
export class RedisUserOpaqueTokenStores implements UserOpaqueTokenStores {
  public constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}
  public forLife(life: UserProductLife): OpaqueTokenStore {
    return new RedisOwnedOpaqueTokenStore(this.redis, this.prefix, life);
  }
}

export class RedisOwnedOpaqueTokenStore extends RedisOpaqueTokenStore {
  private readonly subject: string;
  private readonly epoch: string;
  private readonly lifecycleKey: string;
  private readonly indexKey: string;
  private readonly valuePrefix: string;

  public constructor(redis: Redis, prefix: string, life: OpaqueStateLife) {
    super(redis, prefix);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        life.userId,
      ) ||
      !Number.isSafeInteger(life.productEpoch) ||
      life.productEpoch < 0
    )
      throw new Error('Opaque state life is invalid.');
    this.subject = createHash('sha256').update(life.userId.toLowerCase()).digest('hex');
    this.epoch = String(life.productEpoch);
    const scopePrefix = `${prefix}:owned-action:{${this.subject}}`;
    this.lifecycleKey = `${scopePrefix}:life`;
    this.indexKey = `${scopePrefix}:${this.epoch}:index`;
    this.valuePrefix = `${scopePrefix}:${this.epoch}:value:`;
  }

  protected override key(id: string, policy: OpaqueStatePolicy): string {
    return (
      this.valuePrefix +
      createHash('sha256')
        .update(`${policy.internal ? 'internal' : 'public'}:${id}`)
        .digest('hex')
    );
  }

  private async evaluate(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    try {
      return await this.redis.eval(script, keys.length, ...keys, ...args);
    } catch {
      throw new Error('Opaque state operation is unavailable.');
    }
  }

  public override async putIfAbsent(
    id: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const policy = opaqueStatePolicy(id);
    if (
      policy === undefined ||
      value.length < 1 ||
      Buffer.byteLength(value, 'utf8') > policy.maxBytes ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 30 ||
      ttlSeconds > policy.maxLifetime
    )
      throw new Error('Opaque token state is invalid.');
    const key = this.key(id, policy);
    const result = await this.evaluate(
      `
      local active = 'active:' .. ARGV[1]
      local state = redis.call('GET', KEYS[1])
      if not state and ARGV[1] == '0' then
        redis.call('SET', KEYS[1], active, 'NX')
        state = redis.call('GET', KEYS[1])
      end
      if state ~= active then return -1 end
      if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
      local references = redis.call('HRANDFIELD', KEYS[2], 100)
      for _, key in ipairs(references) do
        if string.sub(key, 1, string.len(ARGV[4])) ~= ARGV[4] then return -1 end
      end
      for _, key in ipairs(references) do
        if redis.call('EXISTS', key) == 0 then redis.call('HDEL', KEYS[2], key) end
      end
      if redis.call('HLEN', KEYS[2]) >= 10000 then return -1 end
      redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3], 'NX')
      redis.call('HSET', KEYS[2], KEYS[3], 1)
      return 1
    `,
      [this.lifecycleKey, this.indexKey, key],
      [this.epoch, value, ttlSeconds, this.valuePrefix],
    );
    if (result === -1) throw new Error('Opaque state allocation is unavailable.');
    if (result !== 0 && result !== 1) throw new Error('Opaque state allocation is unavailable.');
    return result === 1;
  }

  public override async get(id: string): Promise<string | undefined> {
    const policy = opaqueStatePolicy(id);
    if (policy === undefined) return undefined;
    const key = this.key(id, policy);
    const result = await this.evaluate(
      `
      if redis.call('GET', KEYS[1]) ~= 'active:' .. ARGV[1] then return false end
      return redis.call('GET', KEYS[2])
    `,
      [this.lifecycleKey, key],
      [this.epoch],
    );
    return typeof result === 'string' &&
      result.length > 0 &&
      Buffer.byteLength(result, 'utf8') <= policy.maxBytes
      ? result
      : undefined;
  }

  public async revokeNext(limit = 100, cursor = '0'): Promise<OpaqueStateRevocationBatch> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !/^(0|[1-9][0-9]{0,19})$/u.test(cursor)
    )
      throw new Error('Opaque state revocation limit is invalid.');
    const result = await this.evaluate(
      `
      local active = 'active:' .. ARGV[1]
      local blocked = 'blocked:' .. ARGV[1]
      local state = redis.call('GET', KEYS[1])
      if (not state and ARGV[1] ~= '0') or (state and state ~= active and state ~= blocked) then return {-1,1,'0'} end
      redis.call('SET', KEYS[1], blocked)
      local members = redis.call('HRANDFIELD', KEYS[2], tonumber(ARGV[2]))
      -- Validate the complete bounded batch before deleting any value. A damaged
      -- reverse index never authorizes deleting a counterpart's cached state.
      for _, key in ipairs(members) do
        if string.sub(key, 1, string.len(ARGV[3])) ~= ARGV[3] then return {-1,1,'0'} end
      end
      local removed = 0
      for _, key in ipairs(members) do
        removed = removed + redis.call('DEL', key)
        redis.call('HDEL', KEYS[2], key)
      end
      if #members > 0 then return {removed,1,'0'} end
      -- Independently sweep the physically owned namespace. A missing index
      -- entry cannot bless an orphan. Redis COUNT is a hint: cap actual deletes
      -- and restart when a returned page exceeds the exact batch limit.
      local page = redis.call('SCAN', ARGV[4], 'MATCH', ARGV[3] .. '*', 'COUNT', 100)
      local keys = page[2]
      for _, key in ipairs(keys) do
        if string.sub(key, 1, string.len(ARGV[3])) ~= ARGV[3] then return {-1,1,'0'} end
      end
      for i=1,math.min(#keys,tonumber(ARGV[2])) do removed = removed + redis.call('DEL',keys[i]) end
      if #keys > tonumber(ARGV[2]) then return {removed,1,'0'} end
      return {removed,page[1] ~= '0' and 1 or 0,page[1]}
    `,
      [this.lifecycleKey, this.indexKey],
      [this.epoch, limit, this.valuePrefix, cursor],
    );
    if (
      !Array.isArray(result) ||
      result.length !== 3 ||
      typeof result[0] !== 'number' ||
      result[0] < 0 ||
      !Number.isSafeInteger(result[0]) ||
      result[0] > limit ||
      (result[1] !== 0 && result[1] !== 1) ||
      typeof result[2] !== 'string' ||
      !/^(0|[1-9][0-9]{0,19})$/u.test(result[2])
    )
      throw new Error('Opaque state revocation is unavailable.');
    return { removed: result[0], hasMore: result[1] === 1, nextCursor: result[2] };
  }

  /** Independent read-only physical pass. The native coordinator must start at
   * zero and retain every page; the reverse index is only an additional blocker. */
  public async verifyNext(
    cursor = '0',
    limit = 100,
  ): Promise<Readonly<{ found: number; nextCursor: string; hasMore: boolean }>> {
    if (
      !/^(0|[1-9][0-9]{0,19})$/u.test(cursor) ||
      BigInt(cursor) > 18446744073709551615n ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('Opaque state verification is unavailable.');
    const result = await this.evaluate(
      `
      if redis.call('GET',KEYS[1]) ~= 'blocked:' .. ARGV[1] or redis.call('PTTL',KEYS[1]) ~= -1 then return {-1,'0',0} end
      local page=redis.call('SCAN',ARGV[2],'MATCH',ARGV[3] .. '*','COUNT',100)
      local found=math.min(#page[2],tonumber(ARGV[4]))
      if redis.call('HLEN',KEYS[2]) > 0 then found=math.max(found,1) end
      return {found,page[1],page[1] ~= '0' and 1 or 0}
    `,
      [this.lifecycleKey, this.indexKey],
      [this.epoch, cursor, this.valuePrefix, limit],
    );
    if (
      !Array.isArray(result) ||
      result.length !== 3 ||
      typeof result[0] !== 'number' ||
      !Number.isSafeInteger(result[0]) ||
      result[0] < 0 ||
      result[0] > limit ||
      typeof result[1] !== 'string' ||
      !/^(0|[1-9][0-9]{0,19})$/u.test(result[1]) ||
      BigInt(result[1]) > 18446744073709551615n ||
      (result[2] !== 0 && result[2] !== 1) ||
      (result[1] !== '0') !== (result[2] === 1)
    )
      throw new Error('Opaque state verification is unavailable.');
    return { found: result[0], nextCursor: result[1], hasMore: result[2] === 1 };
  }

  /** Tests the write/read fence only. Complete namespace absence additionally
   * requires the owning worker to finish revokeNext's full cursor cycle. */
  public async isWriteRevoked(): Promise<boolean> {
    const result = await this.evaluate(
      `
      return redis.call('GET', KEYS[1]) == 'blocked:' .. ARGV[1] and 1 or 0
    `,
      [this.lifecycleKey],
      [this.epoch],
    );
    if (result !== 0 && result !== 1) throw new Error('Opaque state verification is unavailable.');
    return result === 1;
  }
}

export { RedisAccountDeletionEphemeralProvider } from './account-deletion-ephemeral-provider.js';
