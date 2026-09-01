import { randomUUID } from 'node:crypto';

import { loadConfig } from '@nakh/config';
import { createLogger, startTelemetry } from '@nakh/observability';
import { createRedisConnection, RedisLease } from '@nakh/queue-redis';

const config = loadConfig({
  ...process.env,
  NAKH_SERVICE_NAME: process.env.NAKH_SERVICE_NAME ?? 'scheduler',
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
const redis = createRedisConnection(config.redis.url);
await redis.connect();
const lease = new RedisLease(redis);
const owner = randomUUID();
const leaseKey = `${config.redis.queuePrefix}:scheduler:leader`;

let ticking = false;
const tick = async (): Promise<void> => {
  if (ticking) return;
  ticking = true;
  try {
    const acquired = await lease.acquire(leaseKey, owner, 4_000);
    if (acquired) {
      logger.debug({ operation: 'scheduler.leader-tick' }, 'scheduler lease acquired');
      await lease.release(leaseKey, owner);
    }
  } catch (error) {
    logger.error({ err: error, operation: 'scheduler.tick' }, 'scheduler tick failed');
  } finally {
    ticking = false;
  }
};

await tick();
const timer = setInterval(() => void tick(), 5_000);
logger.info({ operation: 'service.started' }, 'service started');

const shutdown = async (): Promise<void> => {
  clearInterval(timer);
  await lease.release(leaseKey, owner).catch(() => false);
  await redis.quit();
  await telemetry?.shutdown();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
