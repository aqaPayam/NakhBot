import { randomUUID } from 'node:crypto';

import { ReconcileMediaObjectCandidates } from '@nakh/application';
import { loadConfig, resolveSecretReference } from '@nakh/config';
import { AwsR2ObjectClient, R2QuarantineObjectStore } from '@nakh/media-r2';
import { createLogger, M2Metrics, startTelemetry } from '@nakh/observability';
import { createDatabase, PostgresMediaObjectReferenceStore } from '@nakh/persistence-postgres';
import { createRedisConnection, RedisLease } from '@nakh/queue-redis';

import { MediaOrphanScanner } from './media-orphan-scanner.js';

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
const database = createDatabase(config.database);
const lease = new RedisLease(redis);
const owner = randomUUID();
const leaseKey = `${config.redis.queuePrefix}:scheduler:leader`;
const orphanLeaseKey = `${config.redis.queuePrefix}:scheduler:media-orphans`;
const mediaEnvironment = config.environment === 'local' ? 'development' : config.environment;
const orphanClient = !config.media.orphanReconciliationEnabled
  ? undefined
  : new AwsR2ObjectClient({
      endpoint: config.media.r2Endpoint,
      bucket: config.media.bucket,
      accessKeyId: resolveSecretReference(config.media.cleanupAccessKeyRef),
      secretAccessKey: resolveSecretReference(config.media.cleanupSecretKeyRef),
    });
const orphanScanner =
  orphanClient === undefined
    ? undefined
    : new MediaOrphanScanner(
        orphanClient,
        {
          get: async (prefix) =>
            (await redis.get(`${config.redis.queuePrefix}:media-orphan-cursor:${prefix}`)) ??
            undefined,
          advance: async (prefix, cursor) => {
            const key = `${config.redis.queuePrefix}:media-orphan-cursor:${prefix}`;
            if (cursor === undefined) await redis.del(key);
            else await redis.set(key, cursor);
          },
        },
        new ReconcileMediaObjectCandidates(
          new PostgresMediaObjectReferenceStore(database),
          new R2QuarantineObjectStore(orphanClient),
          mediaEnvironment,
          config.media.orphanGraceMs,
        ),
        mediaEnvironment,
      );
const mediaMetrics = orphanScanner === undefined ? undefined : new M2Metrics();

let ticking = false;
const tick = async (): Promise<void> => {
  if (ticking) return;
  ticking = true;
  try {
    const acquired = await lease.acquire(leaseKey, owner, 4_000);
    if (acquired) {
      logger.debug({ operation: 'scheduler.leader-tick' }, 'scheduler lease acquired');
      if (orphanScanner !== undefined) {
        const runAcquired = await lease.acquire(orphanLeaseKey, owner, 30 * 60_000);
        if (runAcquired)
          try {
            const result = await orphanScanner.scanOnePagePerPrefix();
            mediaMetrics?.recordOrphanReconciliation(result);
            logger.info(
              { ...result, operation: 'media.orphans.reconciled' },
              'media orphan scan completed',
            );
          } catch (error) {
            mediaMetrics?.recordOrphanFailure();
            await lease.release(orphanLeaseKey, owner).catch(() => false);
            throw error;
          }
      }
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
  await database.destroy();
  await telemetry?.shutdown();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
