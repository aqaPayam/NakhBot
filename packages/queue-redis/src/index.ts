import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

import type { OutboxPublisher } from '@nakh/application';
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
