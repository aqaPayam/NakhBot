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

import type { AppConfig } from '@nakh/config';
import { ApplicationError } from '@nakh/domain';
import { M1Metrics, type M1Outcome, type M1ReasonCode } from '@nakh/observability';
import {
  createDatabase,
  PostgresIdentityStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createRedisConnection, RedisRateLimiter } from '@nakh/queue-redis';
import { TelegramStartAdapter, TelegramWebhookAuthenticator } from '@nakh/telegram';

const AUTHENTICATOR = Symbol('AUTHENTICATOR');
const DATABASE = Symbol('DATABASE');
const START_ADAPTER = Symbol('START_ADAPTER');
const REDIS = Symbol('REDIS');
const M1_METRICS = Symbol('M1_METRICS');

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

@Controller()
class TelegramGatewayController {
  public constructor(
    @Inject(AUTHENTICATOR) private readonly authenticator: TelegramWebhookAuthenticator,
    @Inject(START_ADAPTER) private readonly startAdapter: TelegramStartAdapter,
    @Inject(M1_METRICS) private readonly m1Metrics: M1Metrics,
  ) {}

  @Get('health/live')
  public live(): Readonly<{ status: 'ok' }> {
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
      if (result.handled)
        this.m1Metrics.recordHandler(
          'first_start',
          result.replayed ? 'replay' : 'success',
          performance.now() - startedAt,
        );
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
        {
          provide: START_ADAPTER,
          useValue: TelegramStartAdapter.withStore(
            new PostgresIdentityStore(database),
            new RedisRateLimiter(redis, config.redis.queuePrefix),
          ),
        },
        DatabaseLifecycle,
      ],
    };
  }
}
