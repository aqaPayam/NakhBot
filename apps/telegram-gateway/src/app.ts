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
} from '@nestjs/common';

import type { AppConfig } from '@nakh/config';
import { TelegramWebhookAuthenticator } from '@nakh/telegram';

const AUTHENTICATOR = Symbol('AUTHENTICATOR');

@Controller()
class TelegramGatewayController {
  public constructor(
    @Inject(AUTHENTICATOR) private readonly authenticator: TelegramWebhookAuthenticator,
  ) {}

  @Get('health/live')
  public live(): Readonly<{ status: 'ok' }> {
    return { status: 'ok' };
  }

  @Post('v1/providers/telegram/webhook')
  public webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: unknown,
  ): Readonly<{ accepted: true }> {
    if (!this.authenticator.verify(secret)) throw new UnauthorizedException();
    void update;
    return { accepted: true };
  }
}

@Module({})
export class TelegramGatewayModule {
  public static register(config: AppConfig): DynamicModule {
    return {
      module: TelegramGatewayModule,
      controllers: [TelegramGatewayController],
      providers: [
        {
          provide: AUTHENTICATOR,
          useValue: new TelegramWebhookAuthenticator(config.telegram.webhookSecret),
        },
      ],
    };
  }
}
