import { LikedByOpaqueReferences } from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { ApplicationError, SystemClock } from '@nakh/domain';
import { CatalogRenderer } from '@nakh/localization';
import {
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresTelegramLikedByDeliveryStore,
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
  TelegramLikedByAdapter,
  type TelegramLikedByResult,
} from '@nakh/telegram';

type RedisConnection = ReturnType<typeof createRedisConnection>;
type HandledResult = Extract<TelegramLikedByResult, { handled: true }>;
type PageRequest = Extract<HandledResult, { kind: 'page_request' }>;
type Notice = Extract<HandledResult, { kind: 'notice' }>;
type Adapter = Pick<TelegramLikedByAdapter, 'handle'>;
type DeliveryStore = Pick<PostgresTelegramLikedByDeliveryStore, 'enqueue'>;
type SecretResolver = (reference: string) => string;

export interface TelegramLikedByCallbackDelivery {
  acknowledgePage(callbackQueryId: string): Promise<void>;
  deliverNotice(notice: Notice): Promise<void>;
}

export interface TelegramLikedByIngressPort {
  handle(update: unknown): Promise<TelegramLikedByIngressOutcome>;
}

export type TelegramLikedByIngressOutcome = 'unhandled' | 'enqueued' | 'replayed' | 'notice';

const BOT_TOKEN = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u;

/** Authenticates first, then persists only the compact request before acknowledging a callback. */
export class TelegramLikedByIngress implements TelegramLikedByIngressPort {
  public constructor(
    private readonly botId: string,
    private readonly adapter: Adapter,
    private readonly deliveries: DeliveryStore,
    private readonly callbacks: TelegramLikedByCallbackDelivery,
  ) {
    if (!/^[1-9][0-9]{0,19}$/u.test(botId) || !Number.isSafeInteger(Number(botId)))
      throw new Error('Telegram bot identity is invalid.');
  }

  public async handle(update: unknown): Promise<TelegramLikedByIngressOutcome> {
    const result = await this.adapter.handle(update);
    if (!result.handled) return 'unhandled';
    if (result.kind === 'notice') {
      await this.callbacks.deliverNotice(result);
      return 'notice';
    }
    const replayed = await this.persist(result);
    if (result.callbackQueryId !== undefined)
      await this.callbacks.acknowledgePage(result.callbackQueryId);
    return replayed ? 'replayed' : 'enqueued';
  }

  private async persist(request: PageRequest): Promise<boolean> {
    const result = await this.deliveries.enqueue({
      botId: this.botId,
      updateId: request.updateId,
      userId: request.userId,
      telegramUserId: request.telegramUserId,
      requestId: request.requestId,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.callbackQueryId === undefined
        ? {}
        : { callbackQueryId: request.callbackQueryId }),
    });
    return result.replayed;
  }
}

function secretKey(reference: string, resolve: SecretResolver): Uint8Array {
  const encoded = resolve(reference);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error('Invalid 32-byte secret key.');
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded)
    throw new Error('Invalid 32-byte secret key.');
  return key;
}

export function createTelegramLikedByIngress(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: RedisConnection;
    resolveSecret?: SecretResolver;
  }>,
): TelegramLikedByIngressPort {
  if (!input.config.telegram.likedByDeliveryEnabled)
    return { handle: () => Promise.resolve('unhandled') };
  const resolve = input.resolveSecret ?? resolveSecretReference;
  const botToken = resolve(input.config.telegram.botTokenRef);
  const match = BOT_TOKEN.exec(botToken);
  if (match === null || !Number.isSafeInteger(Number(match[1])))
    throw new Error('Telegram bot token is invalid.');
  const identities = new PostgresIdentityStore(input.database);
  const localization = new PostgresLocalizationStore(input.database);
  const client = new TelegramBotApiMenuClient(botToken);
  return new TelegramLikedByIngress(
    match[1]!,
    new TelegramLikedByAdapter(
      new PostgresTelegramUserResolver(input.database),
      new LikedByOpaqueReferences(
        new RedisOpaqueTokenStore(input.redis, input.config.redis.queuePrefix),
        secretKey(input.config.telegram.actionTokenKeyRef, resolve),
      ),
      new RedisRateLimiter(input.redis, input.config.redis.queuePrefix),
    ),
    new PostgresTelegramLikedByDeliveryStore(
      input.database,
      new SystemIdGenerator(),
      new SystemClock(),
    ),
    {
      acknowledgePage: (callbackQueryId) => client.answerCallback(callbackQueryId),
      deliverNotice: async (notice): Promise<void> => {
        const identity = await identities.getByUserId(notice.userId);
        if (identity === undefined)
          throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
        const catalog = await localization.loadActiveCatalog(identity.uiLocale);
        const renderer = new CatalogRenderer(
          { [catalog.resolvedLocale]: catalog.messages },
          catalog.resolvedLocale,
        );
        await client.answerCallback(
          notice.callbackQueryId,
          renderer.render(catalog.resolvedLocale, notice.notice),
        );
      },
    },
  );
}
