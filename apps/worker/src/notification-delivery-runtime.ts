import { NotificationDeliveryCoordinator } from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { SystemClock } from '@nakh/domain';
import {
  PostgresLocalizationStore,
  PostgresNotificationDeliveryStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramNotificationSender } from '@nakh/telegram';

import { NotificationDeliveryProcessor } from './notification-delivery-processor.js';
import { WorkerNotificationRenderer } from './notification-renderer.js';

type SecretResolver = (reference: string) => string;

export type TelegramNotificationDeliveryRuntime = Readonly<{
  processNext: NotificationDeliveryProcessor['processNext'];
}>;

/** Builds the real Telegram notification path only behind its explicit staging gate. */
export function createTelegramNotificationDeliveryRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    owner: string;
    resolveSecret?: SecretResolver;
  }>,
): TelegramNotificationDeliveryRuntime | undefined {
  if (!input.config.telegram.notificationDeliveryEnabled) return undefined;
  const store = new PostgresNotificationDeliveryStore(input.database);
  const coordinator = new NotificationDeliveryCoordinator(store, new SystemClock());
  const processor = new NotificationDeliveryProcessor(
    coordinator,
    new WorkerNotificationRenderer(new PostgresLocalizationStore(input.database)),
    new TelegramNotificationSender(
      (input.resolveSecret ?? resolveSecretReference)(input.config.telegram.botTokenRef),
    ),
    input.owner,
  );
  return { processNext: () => processor.processNext() };
}
