import { ApplicationError } from '@nakh/domain';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { CatalogRenderer } from '@nakh/localization';
import {
  PostgresAccountControlSessionStore,
  PostgresFreshEntryActivationAuthority,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresTelegramUserResolver,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  RedisAccountReturnActivation,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import {
  TelegramFreshEntryAdapter,
  TelegramBotApiMenuClient,
  type TelegramFreshEntryNotice,
} from '@nakh/telegram';

export interface TelegramFreshEntryIngressPort {
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
}
export class TelegramFreshEntryIngress implements TelegramFreshEntryIngressPort {
  public constructor(
    private readonly adapter: Pick<TelegramFreshEntryAdapter, 'handle'>,
    private readonly deliver: (notice: TelegramFreshEntryNotice) => Promise<void>,
  ) {}
  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    try {
      const result = await this.adapter.handle(update);
      if (!result.handled) return 'unhandled';
      await this.deliver(result);
      return 'notice';
    } catch (error) {
      if (error instanceof ApplicationError && error.status < 500) throw error;
      throw new ApplicationError('internal_error', 'error.deletion.unavailable', 500);
    }
  }
}
/** The actual webhook controller authenticates the provider before this port. */
export function createTelegramFreshEntryIngress(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (reference: string) => string;
    afterActivation?: (notice: TelegramFreshEntryNotice) => Promise<void>;
  }>,
): TelegramFreshEntryIngressPort {
  if (!input.config.deletion.freshEntryTelegramEnabled)
    return { handle: () => Promise.resolve('unhandled') };
  const resolve = input.resolveSecret ?? resolveSecretReference,
    botToken = resolve(input.config.telegram.botTokenRef),
    match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(botToken);
  if (match === null || !Number.isSafeInteger(Number(match[1])))
    throw new Error('Telegram bot token invalid.');
  const encoded = resolve(input.config.deletion.confirmationKeyRef),
    key = Buffer.from(encoded, 'base64url');
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(encoded) ||
    key.length !== 32 ||
    key.toString('base64url') !== encoded
  )
    throw new Error('Fresh entry confirmation key unavailable.');
  const users = new PostgresTelegramUserResolver(input.database),
    grants = new PostgresAccountControlSessionStore(input.database),
    identities = new PostgresIdentityStore(input.database),
    localization = new PostgresLocalizationStore(input.database),
    client = new TelegramBotApiMenuClient(botToken);
  return new TelegramFreshEntryIngress(
    new TelegramFreshEntryAdapter(
      match[1]!,
      users,
      grants,
      (actor) =>
        new RedisAccountReturnActivation(
          input.redis,
          input.config.redis.queuePrefix,
          new PostgresFreshEntryActivationAuthority(input.database, actor),
        ),
      new RedisRateLimiter(input.redis, input.config.redis.queuePrefix),
      key,
    ),
    async (notice) => {
      const identity = await identities.getByUserId(notice.userId);
      if (identity === undefined)
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      const catalog = await localization.loadActiveCatalog(identity.uiLocale),
        renderer = new CatalogRenderer(
          { [catalog.resolvedLocale]: catalog.messages },
          catalog.resolvedLocale,
        );
      const menu = {
        text: renderer.render(catalog.resolvedLocale, notice.notice),
        replyMarkup: {
          inline_keyboard:
            notice.buttons.length === 0
              ? []
              : [
                  notice.buttons.map((button) => {
                    if (Buffer.byteLength(button.callbackData, 'utf8') > 64)
                      throw new Error('Fresh entry callback oversized.');
                    return {
                      text: renderer.render(catalog.resolvedLocale, button.label),
                      callback_data: button.callbackData,
                    };
                  }),
                ],
        },
      };
      async function current(): Promise<void> {
        const life = await users.resolveProductLife(notice.telegramUserId);
        if (life?.userId !== notice.userId || life.productEpoch !== notice.productEpoch)
          throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
        if (notice.control === undefined) {
          if (
            !['entry.unavailable', 'entry.rate_limited'].includes(notice.notice.key) ||
            notice.buttons.length !== 0
          )
            throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
        } else if (
          notice.control.kind !== 'user' ||
          notice.control.scope !== 'account_control' ||
          notice.control.userId !== notice.userId ||
          notice.control.productEpoch !== notice.productEpoch ||
          (await grants.current(notice.control, notice.control.controlGrantId)) === undefined
        )
          throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      }
      await current();
      if (notice.callbackQueryId !== undefined) {
        await client.answerCallback(notice.callbackQueryId);
        await current();
      }
      await client.sendMenu(notice.telegramUserId, menu);
      if (notice.notice.key === 'entry.completed') {
        await current();
        await input.afterActivation?.(notice);
      }
    },
  );
}
