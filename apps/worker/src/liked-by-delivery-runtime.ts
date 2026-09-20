import {
  EnsureBlurredPreview,
  GetLockedLikedByPageHandler,
  LikedByOpaqueReferences,
  ResolveMediaDeliveryGrantHandler,
} from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { SystemClock } from '@nakh/domain';
import {
  HmacMediaAudienceCredentials,
  HmacMediaDeliveryTokens,
  MediaDeliveryUrlSigner,
} from '@nakh/media-delivery';
import { AwsR2ObjectClient, R2QuarantineObjectStore } from '@nakh/media-r2';
import {
  PostgresBlurGenerationStore,
  PostgresIdentityStore,
  PostgresLikedByStore,
  PostgresLocalizationStore,
  PostgresMediaDeliveryAuthorization,
  PostgresTelegramLikedByDeliveryStore,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { RedisOpaqueTokenStore, type createRedisConnection } from '@nakh/queue-redis';
import {
  TelegramLikedByPageProcessor,
  TelegramLockedLikedByMediaRelay,
  TelegramLockedLikedByPresenter,
  TelegramLockedLikedByScreenRelay,
} from '@nakh/telegram';

import { TelegramLikedByDeliveryProcessor } from './liked-by-delivery-processor.js';
import { WorkerTelegramLikedByRendererProvider } from './liked-by-renderer-provider.js';
import { ResumableTelegramLikedBySender } from './liked-by-resumable-sender.js';
import { SharpBlurTransformer } from './media/blur-transformer.js';

type RedisConnection = ReturnType<typeof createRedisConnection>;
type SecretResolver = (reference: string) => string;

export type TelegramLikedByDeliveryRuntime = Pick<TelegramLikedByDeliveryProcessor, 'processNext'>;

function secretKey(reference: string, resolve: SecretResolver, maximumBytes = 64): Uint8Array {
  const encoded = resolve(reference);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error('Invalid delivery secret key.');
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength < 32 || key.byteLength > maximumBytes || key.toString('base64url') !== encoded)
    throw new Error('Invalid delivery secret key.');
  return key;
}

/** Builds the complete production graph only after the explicit activation gate is enabled. */
export function createTelegramLikedByDeliveryRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: RedisConnection;
    owner: string;
    resolveSecret?: SecretResolver;
  }>,
): TelegramLikedByDeliveryRuntime | undefined {
  if (!input.config.telegram.likedByDeliveryEnabled) return undefined;

  const resolve = input.resolveSecret ?? resolveSecretReference;
  const mediaOrigin = `https://${input.config.media.cdnHost}`;
  const botToken = resolve(input.config.telegram.botTokenRef);
  const actionKey = secretKey(input.config.telegram.actionTokenKeyRef, resolve, 32);
  const signingKey = secretKey(input.config.media.signingKeyRef, resolve);
  const audienceKey = secretKey(input.config.media.audienceKeyRef, resolve);
  const mediaEnvironment =
    input.config.environment === 'local' ? 'development' : input.config.environment;
  const objects = new R2QuarantineObjectStore(
    new AwsR2ObjectClient({
      endpoint: input.config.media.r2Endpoint,
      bucket: input.config.media.bucket,
      accessKeyId: resolve(input.config.media.accessKeyRef),
      secretAccessKey: resolve(input.config.media.secretKeyRef),
    }),
  );
  const references = new LikedByOpaqueReferences(
    new RedisOpaqueTokenStore(input.redis, input.config.redis.queuePrefix),
    actionKey,
  );
  const page = new GetLockedLikedByPageHandler(
    new PostgresLikedByStore(input.database),
    references,
    new EnsureBlurredPreview(
      new PostgresBlurGenerationStore(input.database, mediaEnvironment),
      objects,
      new SharpBlurTransformer(),
    ),
    new ResolveMediaDeliveryGrantHandler(
      new PostgresMediaDeliveryAuthorization(input.database),
      new MediaDeliveryUrlSigner(
        mediaOrigin,
        new HmacMediaDeliveryTokens({
          currentKeyId: input.config.media.signingKeyId,
          keys: new Map([[input.config.media.signingKeyId, signingKey]]),
        }),
      ),
      new SystemClock(),
    ),
  );
  const deliveryStore = new PostgresTelegramLikedByDeliveryStore(
    input.database,
    new SystemIdGenerator(),
    new SystemClock(),
  );
  const renderer = new WorkerTelegramLikedByRendererProvider(
    new PostgresIdentityStore(input.database),
    new PostgresLocalizationStore(input.database),
  );
  const sender = new ResumableTelegramLikedBySender(
    deliveryStore,
    renderer,
    new TelegramLockedLikedByScreenRelay(botToken),
    new TelegramLockedLikedByMediaRelay(
      mediaOrigin,
      botToken,
      new HmacMediaAudienceCredentials(mediaOrigin, {
        currentKeyId: input.config.media.audienceKeyId,
        keys: new Map([[input.config.media.audienceKeyId, audienceKey]]),
      }),
    ),
  );
  return new TelegramLikedByDeliveryProcessor(
    deliveryStore,
    new TelegramLikedByPageProcessor(page, new TelegramLockedLikedByPresenter(mediaOrigin)),
    sender,
    input.owner,
  );
}
