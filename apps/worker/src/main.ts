import { randomUUID } from 'node:crypto';

import { loadConfig } from '@nakh/config';
import { createLogger, startTelemetry } from '@nakh/observability';
import {
  createDatabase,
  PostgresInboxStore,
  PostgresOutboxStore,
  SystemIdGenerator,
} from '@nakh/persistence-postgres';
import {
  BullMqOutboxPublisher,
  createDomainEventWorker,
  createRedisConnection,
} from '@nakh/queue-redis';

const config = loadConfig({
  ...process.env,
  NAKH_SERVICE_NAME: process.env.NAKH_SERVICE_NAME ?? 'worker',
});
const logger = createLogger({
  service: config.serviceName,
  release: config.release,
  environment: config.environment,
});
const telemetry = await startTelemetry({
  enabled: config.telemetry.enabled,
  endpoint: config.telemetry.exporterEndpoint,
  serviceName: config.serviceName,
  release: config.release,
  environment: config.environment,
});
const database = createDatabase(config.database);
const publisherConnection = createRedisConnection(config.redis.url);
const workerConnection = createRedisConnection(config.redis.url);
await Promise.all([publisherConnection.connect(), workerConnection.connect()]);
const publisher = new BullMqOutboxPublisher(publisherConnection, config.redis.queuePrefix);
const outbox = new PostgresOutboxStore(database);
const inbox = new PostgresInboxStore(database, new SystemIdGenerator());
const owner = `${config.serviceName}-${randomUUID()}`;
const eventWorker = createDomainEventWorker(
  workerConnection,
  config.redis.queuePrefix,
  async (event) => {
    await inbox.processSampleEvent(event);
  },
);

let dispatching = false;
const dispatch = async (): Promise<void> => {
  if (dispatching) return;
  dispatching = true;
  try {
    const events = await outbox.claimBatch({ owner, now: new Date(), leaseMs: 30_000, limit: 50 });
    for (const event of events) {
      try {
        await publisher.publish(event);
        await outbox.markPublished(event.id, owner, new Date());
      } catch (error) {
        const code = error instanceof Error ? error.constructor.name : 'unknown_error';
        await outbox.release(event.id, owner, code, new Date(Date.now() + 1_000));
        logger.warn(
          { eventId: event.id, errorCode: code, operation: 'outbox.publish' },
          'outbox publish failed',
        );
      }
    }
  } catch (error) {
    logger.error({ err: error, operation: 'outbox.dispatch' }, 'outbox dispatch failed');
  } finally {
    dispatching = false;
  }
};

await dispatch();
const timer = setInterval(() => void dispatch(), 250);
logger.info({ operation: 'service.started' }, 'service started');

const shutdown = async (): Promise<void> => {
  clearInterval(timer);
  await eventWorker.close();
  await publisher.close();
  await Promise.all([publisherConnection.quit(), workerConnection.quit()]);
  await database.destroy();
  await telemetry?.shutdown();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
