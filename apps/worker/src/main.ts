import { randomUUID } from 'node:crypto';

import { DownloadTelegramPhotoToQuarantine, ValidateQuarantinedPhoto } from '@nakh/application';
import { loadConfig, resolveSecretReference } from '@nakh/config';
import { ClamdMalwareScanner } from '@nakh/media-clamav';
import { AwsR2ObjectClient, R2QuarantineObjectStore } from '@nakh/media-r2';
import { createLogger, M2Metrics, startTelemetry } from '@nakh/observability';
import {
  createDatabase,
  PostgresInboxStore,
  PostgresMediaStore,
  PostgresMediaValidationStore,
  PostgresOutboxStore,
  SystemIdGenerator,
} from '@nakh/persistence-postgres';
import {
  BullMqOutboxPublisher,
  createDomainEventWorker,
  createRedisConnection,
} from '@nakh/queue-redis';
import { TelegramMediaTransportCipher, TelegramPhotoDownloadAdapter } from '@nakh/telegram';

import { WorkerEventProcessor } from './event-processor.js';
import { SharpPhotoTransformer } from './media/image-transformer.js';

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
const mediaOwner = randomUUID();
const mediaEnvironment = config.environment === 'local' ? 'development' : config.environment;
const mediaCipher = config.media.ingestionEnabled
  ? new TelegramMediaTransportCipher(
      mediaEnvironment,
      config.media.transportKeyId,
      new Map([[config.media.transportKeyId, transportKey(config.media.transportKeyRef)]]),
    )
  : undefined;
const mediaObjects =
  mediaCipher === undefined
    ? undefined
    : new R2QuarantineObjectStore(
        new AwsR2ObjectClient({
          endpoint: config.media.r2Endpoint,
          bucket: config.media.bucket,
          accessKeyId: resolveSecretReference(config.media.accessKeyRef),
          secretAccessKey: resolveSecretReference(config.media.secretKeyRef),
        }),
      );
const mediaHandler =
  mediaCipher === undefined || mediaObjects === undefined
    ? undefined
    : new DownloadTelegramPhotoToQuarantine(
        new PostgresMediaStore(database, mediaEnvironment, mediaCipher),
        new TelegramPhotoDownloadAdapter(resolveSecretReference(config.telegram.botTokenRef)),
        mediaObjects,
        new ClamdMalwareScanner({
          host: config.media.clamavHost,
          port: config.media.clamavPort,
          timeoutMs: config.media.clamavTimeoutMs,
        }),
      );
const validationHandler =
  mediaObjects === undefined
    ? undefined
    : new ValidateQuarantinedPhoto(
        new PostgresMediaValidationStore(database, mediaEnvironment),
        mediaObjects,
        new SharpPhotoTransformer(),
      );
const eventProcessor = new WorkerEventProcessor(
  inbox,
  mediaOwner,
  mediaHandler,
  mediaHandler === undefined ? undefined : new M2Metrics(),
  Date.now,
  validationHandler,
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
      eventTypes: config.media.ingestionEnabled
        ? [
            'platform.sample-effect-created.v1',
            'media.ingestion-requested.v1',
            'media.quarantine-uploaded.v1',
          ]
        : ['platform.sample-effect-created.v1'],
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
