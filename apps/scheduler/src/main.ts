import { randomUUID } from 'node:crypto';

import {
  ReconcileMediaObjectCandidates,
  RunBillingReconciliationBatchHandler,
  RunNakhMaintenanceBatchHandler,
  RunNakhReconciliationBatchHandler,
} from '@nakh/application';
import { loadConfig, resolveSecretReference } from '@nakh/config';
import { AwsR2ObjectClient, R2QuarantineObjectStore } from '@nakh/media-r2';
import { createLogger, M2Metrics, M4Metrics, M5Metrics, startTelemetry } from '@nakh/observability';
import {
  createDatabase,
  PostgresBillingReconciliationStore,
  PostgresMediaObjectReferenceStore,
  PostgresNakhMaintenanceStore,
  PostgresNakhOperationalMetricsStore,
  PostgresNakhReconciliationStore,
} from '@nakh/persistence-postgres';
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
const billingReconciliation = new RunBillingReconciliationBatchHandler(
  new PostgresBillingReconciliationStore(database),
);
const billingMetrics = new M4Metrics();
const billingReconciliationIntervalMs = 15 * 60_000;
const nakhMaintenance = new RunNakhMaintenanceBatchHandler(
  new PostgresNakhMaintenanceStore(database),
);
const nakhReconciliation = new RunNakhReconciliationBatchHandler(
  new PostgresNakhReconciliationStore(database),
);
const nakhMetrics = new M5Metrics();
const nakhOperationalMetrics = new PostgresNakhOperationalMetricsStore(database);
const nakhReconciliationIntervalMs = 15 * 60_000;
let nextBillingReconciliationAt = 0;
let nextNakhMaintenanceAt = 0;
let nextNakhReconciliationAt = 0;
let nextNakhHealthSampleAt = 0;

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
      if (Date.now() >= nextBillingReconciliationAt) {
        const startedAt = performance.now();
        try {
          const result = await billingReconciliation.execute({
            proposedRunId: randomUUID(),
            limit: 100,
          });
          billingMetrics.recordReconciliationBatch(
            result.completed ? 'completed' : 'in_progress',
            performance.now() - startedAt,
            result.scannedCount,
            result.anomalyCount,
          );
          nextBillingReconciliationAt = result.completed
            ? Date.now() + billingReconciliationIntervalMs
            : Date.now();
          logger.info(
            {
              operation: 'billing.reconciliation.batch',
              completed: result.completed,
              scannedCount: result.scannedCount,
              anomalyCount: result.anomalyCount,
            },
            'billing reconciliation batch completed',
          );
        } catch (error) {
          billingMetrics.recordReconciliationBatch('failure', performance.now() - startedAt);
          nextBillingReconciliationAt = Date.now() + 60_000;
          logger.error(
            { err: error, operation: 'billing.reconciliation.batch' },
            'billing reconciliation batch failed',
          );
        }
      }
      if (Date.now() >= nextNakhMaintenanceAt) {
        const startedAt = performance.now();
        try {
          const result = await nakhMaintenance.execute(100);
          const durationMs = performance.now() - startedAt;
          nakhMetrics.recordMaintenance(
            'pending_expiry',
            'completed',
            durationMs,
            result.pendingExpired.examined,
            result.pendingExpired.changed,
          );
          nakhMetrics.recordMaintenance(
            'delivered_expiry',
            'completed',
            durationMs,
            result.deliveredExpired.examined,
            result.deliveredExpired.changed,
          );
          nakhMetrics.recordMaintenance(
            'reminder',
            'completed',
            durationMs,
            result.remindersSent.examined,
            result.remindersSent.changed,
          );
          nextNakhMaintenanceAt = result.hasMore ? Date.now() : Date.now() + 30_000;
          const changed =
            result.pendingExpired.changed +
            result.deliveredExpired.changed +
            result.remindersSent.changed;
          if (changed > 0 || result.hasMore)
            logger.info(
              { ...result, operation: 'nakh.maintenance.batch' },
              'Nakh maintenance batch completed',
            );
        } catch (error) {
          nakhMetrics.recordMaintenance('batch', 'failure', performance.now() - startedAt);
          nextNakhMaintenanceAt = Date.now() + 5_000;
          logger.error(
            { err: error, operation: 'nakh.maintenance.batch' },
            'Nakh maintenance batch failed',
          );
        }
      }
      if (Date.now() >= nextNakhReconciliationAt) {
        const startedAt = performance.now();
        try {
          const result = await nakhReconciliation.execute({
            proposedRunId: randomUUID(),
            limit: 100,
          });
          nakhMetrics.recordReconciliation(
            result.completed ? 'completed' : 'in_progress',
            result.phase,
            performance.now() - startedAt,
            result.scannedCount,
            result.anomalyCount,
          );
          nextNakhReconciliationAt = result.completed
            ? Date.now() + nakhReconciliationIntervalMs
            : Date.now();
          logger.info(
            {
              operation: 'nakh.reconciliation.batch',
              phase: result.phase,
              completed: result.completed,
              scannedCount: result.scannedCount,
              anomalyCount: result.anomalyCount,
            },
            'Nakh reconciliation batch completed',
          );
        } catch (error) {
          nakhMetrics.recordReconciliation('failure', 'unknown', performance.now() - startedAt);
          nextNakhReconciliationAt = Date.now() + 60_000;
          logger.error(
            { err: error, operation: 'nakh.reconciliation.batch' },
            'Nakh reconciliation batch failed',
          );
        }
      }
      if (Date.now() >= nextNakhHealthSampleAt) {
        try {
          const health = await nakhOperationalMetrics.measure();
          nakhMetrics.recordOperationalHealth(health);
          nextNakhHealthSampleAt = Date.now() + 30_000;
        } catch (error) {
          nakhMetrics.recordOperationalHealthFailure();
          nextNakhHealthSampleAt = Date.now() + 30_000;
          logger.error(
            { err: error, operation: 'nakh.operational-health.measure' },
            'Nakh operational health measurement failed',
          );
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
