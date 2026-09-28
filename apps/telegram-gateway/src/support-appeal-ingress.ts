import {
  BanOpaqueReferences,
  OpenSupportThreadHandler,
  PrepareAppealHandler,
  SubmitAppealHandler,
  SupportOpaqueReferences,
  UserSafetyContactHandler,
} from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { ApplicationError } from '@nakh/domain';
import { CatalogRenderer } from '@nakh/localization';
import {
  PostgresAppealStore,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresSafetyContactStore,
  PostgresSupportStore,
  PostgresTelegramUserResolver,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  RedisOpaqueTokenStore,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import {
  TelegramBotApiMenuClient,
  TelegramSupportAppealAdapter,
  type TelegramSupportAppealResult,
} from '@nakh/telegram';

type Notice = Extract<TelegramSupportAppealResult, { handled: true }>;
export interface TelegramSupportAppealIngressPort {
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
}

/** Business writes finish before delivery; provider retries use the same command identity. */
export class TelegramSupportAppealIngress implements TelegramSupportAppealIngressPort {
  public constructor(
    private readonly adapter: Pick<TelegramSupportAppealAdapter, 'handle'>,
    private readonly deliver: (notice: Notice) => Promise<void>,
  ) {}

  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    try {
      const result = await this.adapter.handle(update);
      if (!result.handled) return 'unhandled';
      await this.deliver(result);
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}

export function createTelegramSupportAppealIngress(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (reference: string) => string;
  }>,
): TelegramSupportAppealIngressPort {
  if (!input.config.telegram.supportAppealEnabled)
    return { handle: () => Promise.resolve('unhandled') };
  const resolve = input.resolveSecret ?? resolveSecretReference;
  const botToken = resolve(input.config.telegram.botTokenRef);
  const match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(botToken);
  if (match === null || !Number.isSafeInteger(Number(match[1])))
    throw new Error('Telegram bot token is invalid.');
  const encoded = resolve(input.config.telegram.actionTokenKeyRef);
  const key = Buffer.from(encoded, 'base64url');
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(encoded) ||
    key.byteLength !== 32 ||
    key.toString('base64url') !== encoded
  )
    throw new Error('Invalid 32-byte secret key.');
  const tokens = new RedisOpaqueTokenStore(input.redis, input.config.redis.queuePrefix);
  const references = new BanOpaqueReferences(tokens, key);
  const appeals = new PostgresAppealStore(input.database);
  const ids = new SystemIdGenerator();
  const identities = new PostgresIdentityStore(input.database);
  const localization = new PostgresLocalizationStore(input.database);
  const client = new TelegramBotApiMenuClient(botToken);
  return new TelegramSupportAppealIngress(
    new TelegramSupportAppealAdapter(
      match[1]!,
      new PostgresTelegramUserResolver(input.database),
      new UserSafetyContactHandler(
        new PostgresSafetyContactStore(input.database),
        new OpenSupportThreadHandler(
          new PostgresSupportStore(input.database),
          new SupportOpaqueReferences(tokens, key),
          ids,
        ),
        new PrepareAppealHandler(appeals, references),
        new SubmitAppealHandler(appeals, references, ids),
      ),
      new RedisRateLimiter(input.redis, input.config.redis.queuePrefix),
    ),
    async (notice): Promise<void> => {
      const identity = await identities.getByUserId(notice.userId);
      if (identity === undefined)
        throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
      const catalog = await localization.loadActiveCatalog(identity.uiLocale);
      const renderer = new CatalogRenderer(
        { [catalog.resolvedLocale]: catalog.messages },
        catalog.resolvedLocale,
      );
      await client.sendMenu(notice.telegramUserId, {
        text: renderer.render(catalog.resolvedLocale, notice.notice),
        replyMarkup: { inline_keyboard: [] },
      });
    },
  );
}
