import { randomUUID } from 'node:crypto';

import {
  DeletePhotoMediaObjects,
  DownloadTelegramPhotoToQuarantine,
  RevokePhotoDeliveryCache,
  SettlePendingNakhesHandler,
  ValidateQuarantinedPhoto,
} from '@nakh/application';
import { loadConfig, resolveSecretReference } from '@nakh/config';
import { ClamdMalwareScanner } from '@nakh/media-clamav';
import { CloudflareMediaCachePurger } from '@nakh/media-delivery';
import { AwsR2ObjectClient, R2QuarantineObjectStore } from '@nakh/media-r2';
import {
  createLogger,
  m6RetryClass,
  M2Metrics,
  M3Metrics,
  M5Metrics,
  M6Metrics,
  startTelemetry,
} from '@nakh/observability';
import {
  createDatabase,
  PostgresInboxStore,
  PostgresMediaCleanupStore,
  PostgresMediaDeliveryPathStore,
  PostgresMediaStore,
  PostgresMediaValidationStore,
  PostgresOutboxStore,
  PostgresPendingNakhSettlementStore,
  PostgresTelegramStarsReceiptStore,
  SystemIdGenerator,
} from '@nakh/persistence-postgres';
import {
  BullMqOutboxPublisher,
  createDomainEventWorker,
  createRedisConnection,
} from '@nakh/queue-redis';
import { TelegramMediaTransportCipher, TelegramPhotoDownloadAdapter } from '@nakh/telegram';

import { WorkerEventProcessor } from './event-processor.js';
import { createTelegramLikedByDeliveryRuntime } from './liked-by-delivery-runtime.js';
import { SharpPhotoTransformer } from './media/image-transformer.js';
import { createTelegramNotificationDeliveryRuntime } from './notification-delivery-runtime.js';
import { PaymentFulfillmentProcessor } from './payment-fulfillment-processor.js';

function transportKey(reference: string): Uint8Array {
  const encoded = resolveSecretReference(reference);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error('Invalid media transport key.');
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded)
    throw new Error('Invalid media transport key.');
  return key;
}

const config = loadConfig({
  ...process.env,
  NAKH_SERVICE_NAME: process.env.NAKH_SERVICE_NAME ?? 'worker',
});
const cachePurger = config.media.cachePurgeEnabled
  ? new CloudflareMediaCachePurger({
      zoneId: config.media.cloudflareZoneId,
      apiToken: resolveSecretReference(config.media.cloudflareApiTokenRef),
      mediaOrigin: `https://${config.media.cdnHost}`,
    })
  : undefined;
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
const ids = new SystemIdGenerator();
const nakhMetrics = new M5Metrics();
const inbox = new PostgresInboxStore(database, ids);
const owner = `${config.serviceName}-${randomUUID()}`;
const paymentFulfillment = new PaymentFulfillmentProcessor(
  PostgresTelegramStarsReceiptStore.forFulfillment(database),
  ids,
  `payment-fulfillment-${randomUUID()}`,
);
const likedByDelivery = createTelegramLikedByDeliveryRuntime({
  config,
  database,
  redis: workerConnection,
  owner: `telegram-liked-by-${randomUUID()}`,
});
const likedByMetrics = likedByDelivery === undefined ? undefined : new M3Metrics();
const notificationDelivery = createTelegramNotificationDeliveryRuntime({
  config,
  database,
  owner: `telegram-notification-${randomUUID()}`,
});
const chatMetrics = notificationDelivery === undefined ? undefined : new M6Metrics();
const mediaOwner = randomUUID();
const mediaEnvironment = config.environment === 'local' ? 'development' : config.environment;
const mediaCipher = config.media.ingestionEnabled
  ? new TelegramMediaTransportCipher(
      mediaEnvironment,
      config.media.transportKeyId,
      new Map([[config.media.transportKeyId, transportKey(config.media.transportKeyRef)]]),
    )
  : undefined;
const ingestionObjects = !config.media.ingestionEnabled
  ? undefined
  : new R2QuarantineObjectStore(
      new AwsR2ObjectClient({
        endpoint: config.media.r2Endpoint,
        bucket: config.media.bucket,
        accessKeyId: resolveSecretReference(config.media.accessKeyRef),
        secretAccessKey: resolveSecretReference(config.media.secretKeyRef),
      }),
    );
const cleanupObjects = !config.media.cleanupEnabled
  ? undefined
  : new R2QuarantineObjectStore(
      new AwsR2ObjectClient({
        endpoint: config.media.r2Endpoint,
        bucket: config.media.bucket,
        accessKeyId: resolveSecretReference(config.media.cleanupAccessKeyRef),
        secretAccessKey: resolveSecretReference(config.media.cleanupSecretKeyRef),
      }),
    );
const mediaHandler =
  mediaCipher === undefined || ingestionObjects === undefined
    ? undefined
    : new DownloadTelegramPhotoToQuarantine(
        new PostgresMediaStore(database, mediaEnvironment, mediaCipher),
        new TelegramPhotoDownloadAdapter(resolveSecretReference(config.telegram.botTokenRef)),
        ingestionObjects,
        new ClamdMalwareScanner({
          host: config.media.clamavHost,
          port: config.media.clamavPort,
          timeoutMs: config.media.clamavTimeoutMs,
        }),
      );
const validationHandler =
  ingestionObjects === undefined
    ? undefined
    : new ValidateQuarantinedPhoto(
        new PostgresMediaValidationStore(database, mediaEnvironment),
        ingestionObjects,
        new SharpPhotoTransformer(),
      );
const cacheRevocationHandler = cachePurger
  ? new RevokePhotoDeliveryCache(new PostgresMediaDeliveryPathStore(database), cachePurger)
  : undefined;
const mediaCleanupHandler =
  cleanupObjects === undefined
    ? undefined
    : new DeletePhotoMediaObjects(
        new PostgresMediaCleanupStore(database),
        cleanupObjects,
        mediaEnvironment,
      );
const eventProcessor = new WorkerEventProcessor(
  inbox,
  mediaOwner,
  mediaHandler,
  mediaHandler === undefined && mediaCleanupHandler === undefined ? undefined : new M2Metrics(),
  Date.now,
  validationHandler,
  cacheRevocationHandler,
  mediaCleanupHandler,
  new SettlePendingNakhesHandler(new PostgresPendingNakhSettlementStore(database), ids),
  nakhMetrics,
  notificationDelivery,
);
const eventWorker = createDomainEventWorker(workerConnection, config.redis.queuePrefix, (event) =>
  eventProcessor.process(event),
);

let dispatching = false;
const dispatch = async (): Promise<void> => {
  if (dispatching) return;
  dispatching = true;
  try {
    const events = await outbox.claimBatch({
      owner,
      now: new Date(),
      leaseMs: 30_000,
      limit: 50,
      eventTypes: [
        'platform.sample-effect-created.v1',
        'billing.credit-increased.v1',
        ...(config.media.ingestionEnabled
          ? ['media.ingestion-requested.v1', 'media.quarantine-uploaded.v1']
          : []),
        ...(config.media.cachePurgeEnabled ? ['media.photo-hidden.v1'] : []),
        ...(config.media.cachePurgeEnabled || config.media.cleanupEnabled
          ? ['media.photo-deleted.v1']
          : []),
        ...(notificationDelivery === undefined ? [] : ['notification.delivery-requested.v1']),
      ],
    });
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

let notificationDispatching = false;
const dispatchNotification = async (): Promise<void> => {
  if (notificationDelivery === undefined || notificationDispatching) return;
  notificationDispatching = true;
  const startedAt = performance.now();
  try {
    const result = await notificationDelivery.processNext();
    if (result.outcome !== 'idle')
      chatMetrics?.recordDelivery(
        result.outcome,
        m6RetryClass('reasonCode' in result ? result.reasonCode : undefined),
        performance.now() - startedAt,
      );
    if (
      result.outcome === 'retry_scheduled' ||
      result.outcome === 'failed' ||
      result.outcome === 'quarantined'
    )
      logger.warn(
        {
          operation: 'telegram.notification.deliver',
          outcome: result.outcome,
          reasonCode: result.reasonCode,
        },
        'Telegram notification delivery did not complete',
      );
    else if (result.outcome === 'lease_lost')
      logger.warn(
        { operation: 'telegram.notification.deliver', outcome: result.outcome },
        'Telegram notification delivery lease was lost',
      );
  } catch (error) {
    chatMetrics?.recordDelivery('poll_failure', 'transient', performance.now() - startedAt);
    logger.error(
      { err: error, operation: 'telegram.notification.deliver' },
      'Telegram notification delivery polling failed',
    );
  } finally {
    notificationDispatching = false;
  }
};

let likedByDispatching = false;
const dispatchLikedBy = async (): Promise<void> => {
  if (likedByDelivery === undefined || likedByDispatching) return;
  likedByDispatching = true;
  const startedAt = performance.now();
  try {
    const result = await likedByDelivery.processNext();
    if (result.outcome !== 'idle')
      likedByMetrics?.recordTelegramDelivery(
        result.outcome,
        performance.now() - startedAt,
        'reasonCode' in result ? result.reasonCode : 'none',
      );
    if (result.outcome === 'retry_scheduled' || result.outcome === 'failed')
      logger.warn(
        {
          operation: 'telegram.liked_by.deliver',
          outcome: result.outcome,
          reasonCode: result.reasonCode,
        },
        'Telegram Liked By delivery did not complete',
      );
    else if (result.outcome === 'lease_lost')
      logger.warn(
        { operation: 'telegram.liked_by.deliver', outcome: result.outcome },
        'Telegram Liked By delivery lease was lost',
      );
  } catch (error) {
    likedByMetrics?.recordTelegramDelivery(
      'poll_failure',
      performance.now() - startedAt,
      'internal_error',
    );
    logger.error(
      { err: error, operation: 'telegram.liked_by.deliver' },
      'Telegram Liked By delivery polling failed',
    );
  } finally {
    likedByDispatching = false;
  }
};

let paymentFulfillmentDispatching = false;
const dispatchPaymentFulfillment = async (): Promise<void> => {
  if (paymentFulfillmentDispatching) return;
  paymentFulfillmentDispatching = true;
  const startedAt = performance.now();
  try {
    const result = await paymentFulfillment.processNext();
    if (result.outcome !== 'idle' && result.paymentType === 'pay_pending_action')
      nakhMetrics.recordDelivery(
        result.outcome === 'fulfilled' ? 'delivered' : result.outcome,
        'telegram_stars',
        performance.now() - startedAt,
      );
    if (result.outcome === 'retry_scheduled')
      logger.warn(
        {
          operation: 'billing.payment_fulfilling',
          outcome: result.outcome,
          paymentType: result.paymentType,
          reasonCode: result.reasonCode,
        },
        'payment fulfillment retry scheduled',
      );
    else if (result.outcome === 'lease_lost')
      logger.warn(
        { operation: 'billing.payment_fulfilling', outcome: result.outcome },
        'payment fulfillment lease was lost',
      );
  } catch (error) {
    logger.error(
      { err: error, operation: 'billing.payment_fulfilling' },
      'payment fulfillment polling failed',
    );
  } finally {
    paymentFulfillmentDispatching = false;
  }
};

let likedByBacklogSampling = false;
const sampleLikedByBacklog = async (): Promise<void> => {
  if (likedByDelivery === undefined || likedByBacklogSampling) return;
  likedByBacklogSampling = true;
  try {
    const backlog = await likedByDelivery.measureBacklog();
    likedByMetrics?.recordTelegramBacklog(backlog.pendingCount, backlog.oldestAgeSeconds);
  } catch (error) {
    likedByMetrics?.recordTelegramBacklogFailure();
    logger.error(
      { err: error, operation: 'telegram.liked_by.measure_backlog' },
      'Telegram Liked By backlog measurement failed',
    );
  } finally {
    likedByBacklogSampling = false;
  }
};

await Promise.all([
  dispatch(),
  dispatchLikedBy(),
  dispatchPaymentFulfillment(),
  sampleLikedByBacklog(),
  dispatchNotification(),
]);
const timer = setInterval(() => void dispatch(), 250);
const paymentFulfillmentTimer = setInterval(() => void dispatchPaymentFulfillment(), 250);
const likedByTimer =
  likedByDelivery === undefined ? undefined : setInterval(() => void dispatchLikedBy(), 250);
const likedByBacklogTimer =
  likedByDelivery === undefined
    ? undefined
    : setInterval(() => void sampleLikedByBacklog(), 30_000);
const notificationTimer =
  notificationDelivery === undefined
    ? undefined
    : setInterval(() => void dispatchNotification(), 250);
logger.info(
  {
    operation: 'service.started',
    telegramLikedByDeliveryEnabled: likedByDelivery !== undefined,
    telegramNotificationDeliveryEnabled: notificationDelivery !== undefined,
  },
  'service started',
);

const shutdown = async (): Promise<void> => {
  clearInterval(timer);
  clearInterval(paymentFulfillmentTimer);
  if (likedByTimer !== undefined) clearInterval(likedByTimer);
  if (likedByBacklogTimer !== undefined) clearInterval(likedByBacklogTimer);
  if (notificationTimer !== undefined) clearInterval(notificationTimer);
  await eventWorker.close();
  await publisher.close();
  await Promise.all([publisherConnection.quit(), workerConnection.quit()]);
  await database.destroy();
  await telemetry?.shutdown();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
