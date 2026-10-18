import { NotificationDeliveryCoordinator } from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { SystemClock } from '@nakh/domain';
import {
  PostgresLocalizationStore,
  PostgresNotificationDeliveryStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramNotificationSender } from '@nakh/telegram';
import type { createRedisConnection } from '@nakh/queue-redis';

import { NotificationDeliveryProcessor } from './notification-delivery-processor.js';
import { WorkerNotificationRenderer } from './notification-renderer.js';
import { WorkerChatNotificationRenderer } from './chat-notification-renderer.js';

type SecretResolver = (reference: string) => string;

export type TelegramNotificationDeliveryRuntime = Readonly<{
  processNext: NotificationDeliveryProcessor['processNext'];
  verifyReadiness?: () => Promise<void>;
}>;

/** Builds the real Telegram notification path only behind its explicit staging gate. */
export function createTelegramNotificationDeliveryRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    owner: string;
    resolveSecret?: SecretResolver;
    redis?: ReturnType<typeof createRedisConnection>;
  }>,
): TelegramNotificationDeliveryRuntime | undefined {
  if (!input.config.telegram.notificationDeliveryEnabled) return undefined;
  const resolve = input.resolveSecret ?? resolveSecretReference,
    token = resolve(input.config.telegram.botTokenRef);
  const localization = new PostgresLocalizationStore(input.database);
  let chat: WorkerChatNotificationRenderer | undefined;
  if (input.config.telegram.chatEnabled) {
    const bot = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(token),
      encoded = resolve(input.config.telegram.actionTokenKeyRef),
      key = Buffer.from(encoded, 'base64url');
    if (
      input.redis === undefined ||
      bot === null ||
      !Number.isSafeInteger(Number(bot[1])) ||
      key.length !== 32 ||
      key.toString('base64url') !== encoded
    )
      throw Error('Chat delivery composition unavailable.');
    chat = new WorkerChatNotificationRenderer(
      input.database,
      localization,
      input.redis,
      input.config.redis.queuePrefix,
      bot[1]!,
      key,
    );
  }
  const store = new PostgresNotificationDeliveryStore(input.database, {
    chatRelay: input.config.telegram.chatEnabled,
  });
  const coordinator = new NotificationDeliveryCoordinator(store, new SystemClock());
  const processor = new NotificationDeliveryProcessor(
    coordinator,
    chat ?? new WorkerNotificationRenderer(localization),
    new TelegramNotificationSender(token),
    input.owner,
  );
  return {
    processNext: () => processor.processNext(),
    ...(chat === undefined ? {} : { verifyReadiness: () => chat.verifyReadiness() }),
  };
}
