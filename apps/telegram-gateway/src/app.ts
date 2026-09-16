import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Module,
  Post,
  UnauthorizedException,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';

import {
  BeginTelegramPhotoIngestionHandler,
  ListOwnPhotosHandler,
  MutateOwnPhotosHandler,
} from '@nakh/application';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { ApplicationError, SystemClock } from '@nakh/domain';
import { CatalogRenderer } from '@nakh/localization';
import {
  M1Metrics,
  M2Metrics,
  type M1Outcome,
  type M1ReasonCode,
  type M2MediaReasonCode,
} from '@nakh/observability';
import {
  createDatabase,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  PostgresMediaStore,
  PostgresPhotoManagementStore,
  PostgresTelegramUserResolver,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createRedisConnection, RedisOpaqueTokenStore, RedisRateLimiter } from '@nakh/queue-redis';
import {
  TelegramMediaTransportCipher,
  TelegramBotApiMenuClient,
  TelegramPhotoActionTokens,
  TelegramPhotoIngestionAdapter,
  TelegramPhotoManagementAdapter,
  TelegramPhotoMenuPresenter,
  TelegramStartAdapter,
  TelegramWebhookAuthenticator,
  renderTelegramPhotoMenu,
  type TelegramPhotoManagementResult,
} from '@nakh/telegram';

const AUTHENTICATOR = Symbol('AUTHENTICATOR');
const DATABASE = Symbol('DATABASE');
const START_ADAPTER = Symbol('START_ADAPTER');
const PHOTO_ADAPTER = Symbol('PHOTO_ADAPTER');
const PHOTO_MANAGEMENT_ADAPTER = Symbol('PHOTO_MANAGEMENT_ADAPTER');
const PHOTO_MENU_DELIVERY = Symbol('PHOTO_MENU_DELIVERY');
const REDIS = Symbol('REDIS');
const M1_METRICS = Symbol('M1_METRICS');
const M2_METRICS = Symbol('M2_METRICS');

type PhotoAdapter = Pick<TelegramPhotoIngestionAdapter, 'handle'>;
type PhotoManagementAdapter = Pick<TelegramPhotoManagementAdapter, 'handle'>;
type HandledPhotoManagementResult = Extract<TelegramPhotoManagementResult, { handled: true }>;

type PhotoMenuDelivery = Readonly<{
  deliver(result: HandledPhotoManagementResult): Promise<void>;
}>;

function secretKey(reference: string): Uint8Array {
  const encoded = resolveSecretReference(reference);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error('Invalid 32-byte secret key.');
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded)
    throw new Error('Invalid 32-byte secret key.');
  return key;
}

function applicationOutcome(error: ApplicationError): M1Outcome {
  if (error.status === 409) return 'conflict';
  if (error.status === 401 || error.status === 403 || error.status === 429) return 'denied';
  return 'failure';
}

function applicationReason(error: ApplicationError): M1ReasonCode {
  switch (error.code) {
    case 'rate_limited':
    case 'idempotency_conflict':
    case 'capability_denied':
      return error.code;
    default:
      return 'internal_error';
  }
}

function mediaReason(error: ApplicationError): M2MediaReasonCode {
  switch (error.code) {
    case 'rate_limited':
    case 'invalid_request':
    case 'unauthorized':
    case 'capability_denied':
    case 'idempotency_conflict':
    case 'photo_upload_limit_reached':
    case 'unsupported_media_type':
      return error.code;
    default:
      return 'storage_unavailable';
  }
}

@Controller()
class TelegramGatewayController {
  public constructor(
    @Inject(AUTHENTICATOR) private readonly authenticator: TelegramWebhookAuthenticator,
    @Inject(START_ADAPTER) private readonly startAdapter: TelegramStartAdapter,
    @Inject(PHOTO_ADAPTER) private readonly photoAdapter: PhotoAdapter,
    @Inject(PHOTO_MANAGEMENT_ADAPTER)
    private readonly photoManagementAdapter: PhotoManagementAdapter,
    @Inject(PHOTO_MENU_DELIVERY) private readonly photoMenuDelivery: PhotoMenuDelivery,
    @Inject(M1_METRICS) private readonly m1Metrics: M1Metrics,
    @Inject(M2_METRICS) private readonly m2Metrics: M2Metrics,
    @Inject(DATABASE) private readonly database: NakhDatabase,
    @Inject(REDIS) private readonly redis: ReturnType<typeof createRedisConnection>,
  ) {}

  @Get('health/live')
  public live(): Readonly<{ status: 'ok' }> {
    return { status: 'ok' };
  }

  @Get('health/ready')
  public async ready(): Promise<Readonly<{ status: 'ok' }>> {
    await Promise.all([
      this.database
        .selectNoFrom((expression) => expression.val(1).as('ready'))
        .executeTakeFirstOrThrow(),
      this.redis.ping(),
    ]);
    return { status: 'ok' };
  }

  @Post('v1/providers/telegram/webhook')
  public async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: unknown,
  ): Promise<Readonly<{ accepted: true }>> {
    if (!this.authenticator.verify(secret)) throw new UnauthorizedException();
    const startedAt = performance.now();
    try {
      const result = await this.startAdapter.handle(update);
      if (result.handled) {
        this.m1Metrics.recordHandler(
          'first_start',
          result.replayed ? 'replay' : 'success',
          performance.now() - startedAt,
        );
        return { accepted: true };
      }
    } catch (error) {
      if (error instanceof ApplicationError) {
        this.m1Metrics.recordHandler(
          'first_start',
          applicationOutcome(error),
          performance.now() - startedAt,
          applicationReason(error),
        );
        throw new HttpException({ code: error.code }, error.status);
      }
      this.m1Metrics.recordHandler(
        'first_start',
        'failure',
        performance.now() - startedAt,
        'internal_error',
      );
      throw error;
    }
    const mediaStartedAt = performance.now();
    try {
      const media = await this.photoAdapter.handle(update);
      if (media.handled) {
        this.m2Metrics.recordIngestion(
          media.result.validationState === 'pending' ? 'accepted' : 'rejected',
          performance.now() - mediaStartedAt,
          media.result.validationState === 'rejected' ? media.result.errorCode : 'none',
        );
        return { accepted: true };
      }
    } catch (error) {
      if (error instanceof ApplicationError) {
        this.m2Metrics.recordIngestion(
          error.status < 500 ? 'rejected' : 'retryable_failure',
          performance.now() - mediaStartedAt,
          mediaReason(error),
        );
        throw new HttpException({ code: error.code }, error.status);
      }
      this.m2Metrics.recordIngestion(
        'retryable_failure',
        performance.now() - mediaStartedAt,
        'storage_unavailable',
      );
      throw error;
    }
    try {
      const management = await this.photoManagementAdapter.handle(update);
      if (management.handled) await this.photoMenuDelivery.deliver(management);
    } catch (error) {
      if (error instanceof ApplicationError)
        throw new HttpException({ code: error.code }, error.status);
      throw error;
    }
    return { accepted: true };
  }
}

class DatabaseLifecycle implements OnApplicationShutdown {
  public constructor(
    @Inject(DATABASE) private readonly database: NakhDatabase,
    @Inject(REDIS) private readonly redis: ReturnType<typeof createRedisConnection>,
  ) {}

  public async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.database.destroy(), this.redis.quit()]);
  }
}

@Module({})
export class TelegramGatewayModule {
  public static register(config: AppConfig): DynamicModule {
    const database = createDatabase(config.database);
    const redis = createRedisConnection(config.redis.url);
    const limiter = new RedisRateLimiter(redis, config.redis.queuePrefix);
    const identityStore = new PostgresIdentityStore(database);
    const mediaEnvironment = config.environment === 'local' ? 'development' : config.environment;
    const photoAdapter: PhotoAdapter = config.media.ingestionEnabled
      ? (() => {
          const cipher = new TelegramMediaTransportCipher(
            mediaEnvironment,
            config.media.transportKeyId,
            new Map([[config.media.transportKeyId, secretKey(config.media.transportKeyRef)]]),
          );
          return new TelegramPhotoIngestionAdapter(
            new PostgresTelegramUserResolver(database),
            new BeginTelegramPhotoIngestionHandler(
              new PostgresMediaStore(database, mediaEnvironment, cipher),
              cipher,
              new SystemIdGenerator(),
              limiter,
            ),
          );
        })()
      : { handle: () => Promise.resolve({ handled: false as const }) };
    const photoManagementAdapter: PhotoManagementAdapter = config.media.ingestionEnabled
      ? (() => {
          const store = new PostgresPhotoManagementStore(database);
          const actionTokens = new TelegramPhotoActionTokens(
            new RedisOpaqueTokenStore(redis, config.redis.queuePrefix),
            secretKey(config.telegram.actionTokenKeyRef),
          );
          return new TelegramPhotoManagementAdapter(
            new PostgresTelegramUserResolver(database),
            {
              list: new ListOwnPhotosHandler(store),
              mutate: new MutateOwnPhotosHandler(store, new SystemIdGenerator(), new SystemClock()),
            },
            limiter,
            undefined,
            actionTokens,
          );
        })()
      : { handle: () => Promise.resolve({ handled: false as const }) };
    const photoMenuDelivery: PhotoMenuDelivery = config.media.ingestionEnabled
      ? (() => {
          const actionTokens = new TelegramPhotoActionTokens(
            new RedisOpaqueTokenStore(redis, config.redis.queuePrefix),
            secretKey(config.telegram.actionTokenKeyRef),
          );
          const presenter = new TelegramPhotoMenuPresenter(actionTokens);
          const localization = new PostgresLocalizationStore(database);
          const client = new TelegramBotApiMenuClient(
            resolveSecretReference(config.telegram.botTokenRef),
          );
          return {
            deliver: async (result: HandledPhotoManagementResult): Promise<void> => {
              const context = await identityStore.getByUserId(result.userId);
              if (context === undefined) throw new Error('Telegram menu identity is unavailable.');
              const catalog = await localization.loadActiveCatalog(context.uiLocale);
              const renderer = new CatalogRenderer(
                { [catalog.resolvedLocale]: catalog.messages },
                catalog.resolvedLocale,
              );
              const model = await presenter.present(result.telegramUserId, result.collection);
              const delivery = client.sendMenu(
                result.telegramUserId,
                renderTelegramPhotoMenu(model, (intent) =>
                  renderer.render(catalog.resolvedLocale, intent),
                ),
              );
              await Promise.all([
                delivery,
                result.callbackQueryId === undefined
                  ? Promise.resolve()
                  : client.answerCallback(result.callbackQueryId),
              ]);
            },
          };
        })()
      : { deliver: () => Promise.resolve() };
    return {
      module: TelegramGatewayModule,
      controllers: [TelegramGatewayController],
      providers: [
        {
          provide: AUTHENTICATOR,
          useValue: new TelegramWebhookAuthenticator(config.telegram.webhookSecret),
        },
        { provide: DATABASE, useValue: database },
        { provide: REDIS, useValue: redis },
        { provide: M1_METRICS, useValue: new M1Metrics() },
        { provide: M2_METRICS, useValue: new M2Metrics() },
        { provide: PHOTO_ADAPTER, useValue: photoAdapter },
        { provide: PHOTO_MANAGEMENT_ADAPTER, useValue: photoManagementAdapter },
        { provide: PHOTO_MENU_DELIVERY, useValue: photoMenuDelivery },
        {
          provide: START_ADAPTER,
          useValue: TelegramStartAdapter.withStore(identityStore, limiter),
        },
        DatabaseLifecycle,
      ],
    };
  }
}
