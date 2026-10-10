import { createHash } from 'node:crypto';

import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

import type {
  OpaqueTokenStore,
  OutboxPublisher,
  RateLimiterPort,
  RateLimitRequest,
} from '@nakh/application';
import type { DomainEvent } from '@nakh/contracts';

export const DOMAIN_EVENT_QUEUE = 'domain-events';

export function createRedisConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
}

export class BullMqOutboxPublisher implements OutboxPublisher {
  private readonly queue: Queue<DomainEvent>;

  public constructor(connection: Redis, prefix: string) {
    this.queue = new Queue<DomainEvent>(DOMAIN_EVENT_QUEUE, { connection, prefix });
  }

  public async publish(event: DomainEvent): Promise<void> {
    const options: JobsOptions = {
      jobId: event.id,
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
      removeOnFail: false,
    };
    await this.queue.add(event.eventType, event, options);
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}

export function createDomainEventWorker(
  connection: Redis,
  prefix: string,
  processor: (event: DomainEvent) => Promise<void>,
): Worker<DomainEvent> {
  return new Worker<DomainEvent>(DOMAIN_EVENT_QUEUE, async (job) => processor(job.data), {
    connection,
    prefix,
    concurrency: 20,
  });
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
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  private key(id: string, policy: OpaqueStatePolicy): string {
    // Existing short action keys retain their physical namespace. Internal UI
    // receipts use a separate hashed namespace and cannot alias public actions.
    return policy.internal
      ? `${this.prefix}:action:internal:${createHash('sha256').update(id).digest('hex')}`
      : `${this.prefix}:action:${id}`;
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
    return (await this.redis.set(this.key(id, policy), value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  public async get(id: string): Promise<string | undefined> {
    const policy = opaqueStatePolicy(id);
    if (policy === undefined) return undefined;
    const value = await this.redis.get(this.key(id, policy));
    return value === null || value.length < 1 || Buffer.byteLength(value, 'utf8') > policy.maxBytes
      ? undefined
      : value;
  }
}
