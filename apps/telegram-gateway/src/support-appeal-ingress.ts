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
  PostgresLaunchCohortAdmission,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  RedisOwnedOpaqueTokenStore,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import {
  TelegramBotApiMenuClient,
  TelegramSupportAppealAdapter,
  type TelegramSupportAppealResult,
} from '@nakh/telegram';
import { TelegramPaymentSupportContact } from './payment-support-contact.js';

type Notice = Extract<TelegramSupportAppealResult, { handled: true }>;
export interface TelegramSupportAppealIngressPort {
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
}

/** Business writes finish before delivery; provider retries use the same command identity. */
export class TelegramSupportAppealIngress implements TelegramSupportAppealIngressPort {
  public constructor(
    private readonly adapter: Pick<TelegramSupportAppealAdapter, 'handle'>,
    private readonly deliver: (notice: Notice) => Promise<void>,
    private readonly publicContact?: Pick<TelegramPaymentSupportContact, 'handle'>,
  ) {}

  public async handle(update: unknown): Promise<'unhandled' | 'notice'> {
    try {
      if ((await this.publicContact?.handle(update)) === 'notice') return 'notice';
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
  const username = input.config.telegram.publicSupportUsername ?? '';
  if (!input.config.telegram.supportAppealEnabled && username === '')
    return { handle: () => Promise.resolve('unhandled') };
  const resolve = input.resolveSecret ?? resolveSecretReference;
  const botToken = resolve(input.config.telegram.botTokenRef);
  const match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(botToken);
  if (match === null || !Number.isSafeInteger(Number(match[1])))
    throw new Error('Telegram bot token is invalid.');
  const client = new TelegramBotApiMenuClient(botToken);
  const publicContact =
    username === ''
      ? undefined
      : new TelegramPaymentSupportContact({
          botId: match[1]!,
          username,
          limiter: new RedisRateLimiter(input.redis, input.config.redis.queuePrefix),
          send: async (recipient, contact) =>
            client.sendMenu(recipient, {
              text: `@${contact}`,
              replyMarkup: {
                inline_keyboard: [[{ text: `@${contact}`, url: `https://t.me/${contact}` }]],
              },
            }),
        });
  if (!input.config.telegram.supportAppealEnabled)
    return new TelegramSupportAppealIngress(
      { handle: () => Promise.resolve({ handled: false }) },
      () => Promise.resolve(),
      publicContact,
    );
  const encoded = resolve(input.config.telegram.actionTokenKeyRef);
  const key = Buffer.from(encoded, 'base64url');
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(encoded) ||
    key.byteLength !== 32 ||
    key.toString('base64url') !== encoded
  )
    throw new Error('Invalid 32-byte secret key.');
  const appeals = new PostgresAppealStore(input.database);
  const support = new PostgresSupportStore(input.database);
  const states = new PostgresSafetyContactStore(input.database);
  const users = new PostgresTelegramUserResolver(input.database);
  const ids = new SystemIdGenerator();
  const identities = new PostgresIdentityStore(input.database);
  const localization = new PostgresLocalizationStore(input.database);
  const feedbackAdmission =
    input.config.environment === 'staging'
      ? new PostgresLaunchCohortAdmission(input.database, {
          sourceSha: input.config.release,
          environment: 'staging',
          telegramBotId: match[1]!,
        })
      : undefined;
  return new TelegramSupportAppealIngress(
    new TelegramSupportAppealAdapter(
      match[1]!,
      users,
      {
        execute: (contact) => {
          const life = { userId: contact.userId, productEpoch: contact.productEpoch };
          const tokens = new RedisOwnedOpaqueTokenStore(
            input.redis,
            input.config.redis.queuePrefix,
            life,
          );
          const references = BanOpaqueReferences.forLife(tokens, key, life);
          return new UserSafetyContactHandler(
            states,
            new OpenSupportThreadHandler(
              support,
              SupportOpaqueReferences.forLife(tokens, key, life),
              ids,
            ),
            new PrepareAppealHandler(appeals, references),
            new SubmitAppealHandler(appeals, references, ids),
          ).execute(contact);
        },
      },
      new RedisRateLimiter(input.redis, input.config.redis.queuePrefix),
      (life) => feedbackAdmission?.allows(life.userId) ?? Promise.resolve(false),
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
      const currentLife = await users.resolveProductLife(notice.telegramUserId);
      if (
        currentLife?.userId !== notice.userId ||
        currentLife?.productEpoch !== notice.productEpoch
      )
        throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
      await client.sendMenu(notice.telegramUserId, {
        text: renderer.render(catalog.resolvedLocale, notice.notice),
        replyMarkup: { inline_keyboard: [] },
      });
    },
    publicContact,
  );
}
