import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Module,
  Post,
  UnauthorizedException,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';

import type { AppConfig } from '@nakh/config';
import {
  createDatabase,
  PostgresIdentityStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { TelegramStartAdapter, TelegramWebhookAuthenticator } from '@nakh/telegram';

const AUTHENTICATOR = Symbol('AUTHENTICATOR');
const DATABASE = Symbol('DATABASE');
const START_ADAPTER = Symbol('START_ADAPTER');

@Controller()
class TelegramGatewayController {
  public constructor(
    @Inject(AUTHENTICATOR) private readonly authenticator: TelegramWebhookAuthenticator,
    @Inject(START_ADAPTER) private readonly startAdapter: TelegramStartAdapter,
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
    await this.startAdapter.handle(update);
    return { accepted: true };
  }
}

class DatabaseLifecycle implements OnApplicationShutdown {
  public constructor(@Inject(DATABASE) private readonly database: NakhDatabase) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}

@Module({})
export class TelegramGatewayModule {
  public static register(config: AppConfig): DynamicModule {
    const database = createDatabase(config.database);
    return {
      module: TelegramGatewayModule,
      controllers: [TelegramGatewayController],
      providers: [
        {
          provide: AUTHENTICATOR,
          useValue: new TelegramWebhookAuthenticator(config.telegram.webhookSecret),
        },
        { provide: DATABASE, useValue: database },
        {
          provide: START_ADAPTER,
          useValue: TelegramStartAdapter.withStore(new PostgresIdentityStore(database)),
        },
        DatabaseLifecycle,
      ],
    };
  }
}
