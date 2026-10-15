import { ApplicationError } from '@nakh/domain';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { CatalogRenderer } from '@nakh/localization';
import {
  PostgresAccountControlSessionStore,
  PostgresAccountReturnStore,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresTelegramUserResolver,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { RedisRateLimiter, type createRedisConnection } from '@nakh/queue-redis';
import {
  TelegramAccountReturnAdapter,
  TelegramBotApiMenuClient,
  type TelegramAccountReturnNotice,
} from '@nakh/telegram';

export interface TelegramAccountReturnIngressPort {
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
}
export class TelegramAccountReturnIngress implements TelegramAccountReturnIngressPort {
  public constructor(
    private readonly adapter: Pick<TelegramAccountReturnAdapter, 'handle'>,
    private readonly deliver: (notice: TelegramAccountReturnNotice) => Promise<void>,
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
export function createTelegramAccountReturnIngress(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    resolveSecret?: (reference: string) => string;
  }>,
): TelegramAccountReturnIngressPort {
  if (!input.config.deletion.returnTelegramEnabled)
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
    throw new Error('Return confirmation key unavailable.');
  const users = new PostgresTelegramUserResolver(input.database),
    grants = new PostgresAccountControlSessionStore(input.database),
    identities = new PostgresIdentityStore(input.database),
    localization = new PostgresLocalizationStore(input.database),
    client = new TelegramBotApiMenuClient(botToken);
  return new TelegramAccountReturnIngress(
    new TelegramAccountReturnAdapter(
      match[1]!,
      users,
      grants,
      (actor) => new PostgresAccountReturnStore(input.database, actor),
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
                      throw new Error('Return callback oversized.');
                    return {
                      text: renderer.render(catalog.resolvedLocale, button.label),
                      callback_data: button.callbackData,
                    };
                  }),
                ],
        },
      };
      async function current(): Promise<void> {
        const life = await users.resolveAccountControlLife(notice.telegramUserId);
        if (life?.userId !== notice.userId)
          throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
        if (notice.control === undefined) {
          if (
            life.productEpoch !== notice.observedProductEpoch ||
            !['return.unavailable', 'return.rate_limited'].includes(notice.notice.key) ||
            notice.buttons.length !== 0
          )
            throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
        } else {
          const original = await grants.findForReturn(notice.userId, notice.control.controlGrantId);
          if (
            notice.control.kind !== 'user' ||
            notice.control.scope !== 'account_return' ||
            notice.control.userId !== notice.userId ||
            original?.userId !== notice.userId ||
            original.productEpoch !== notice.control.productEpoch ||
            original.id !== notice.control.controlGrantId
          )
            throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
        }
      }
      await current();
      if (notice.callbackQueryId !== undefined) {
        await client.answerCallback(notice.callbackQueryId);
        await current();
      }
      await client.sendMenu(notice.telegramUserId, menu);
    },
  );
}
