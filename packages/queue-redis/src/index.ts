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

export class RedisOpaqueTokenStore implements OpaqueTokenStore {
  public constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  public async putIfAbsent(id: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{16}$/u.test(id) || value.length < 1 || value.length > 4096)
      throw new Error('Opaque token state is invalid.');
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600)
      throw new Error('Opaque token lifetime is invalid.');
    return (
      (await this.redis.set(`${this.prefix}:action:${id}`, value, 'EX', ttlSeconds, 'NX')) === 'OK'
    );
  }

  public async get(id: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_-]{16}$/u.test(id)) return undefined;
    return (await this.redis.get(`${this.prefix}:action:${id}`)) ?? undefined;
  }
}
