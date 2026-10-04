import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  type DynamicModule,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { OpenSupportThreadHandler, SendSupportMessageHandler } from '@nakh/application';
import {
  OpenSupportThreadCommandSchema,
  SendSupportMessageCommandSchema,
  UserSupportReceiptSchema,
  type OpenSupportThreadCommand,
  type SendSupportMessageCommand,
  type UserSupportReceipt,
  type SupportThreadResult,
} from '@nakh/contracts';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';

const BOUNDARY = Symbol('M7_SUPPORT_BOUNDARY'),
  OPEN = Symbol('M7_SUPPORT_OPEN'),
  SEND = Symbol('M7_SUPPORT_SEND');
export interface M7SupportApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly open: Pick<OpenSupportThreadHandler, 'execute'>;
  readonly send: Pick<SendSupportMessageHandler, 'execute'>;
}
function receipt(result: SupportThreadResult): UserSupportReceipt {
  return {
    supportActionToken: result.supportActionToken,
    status: result.status,
    unansweredUserMessages: result.unansweredUserMessages,
    version: result.version,
    changedAt: result.changedAt,
    replayed: result.replayed,
  };
}
@Controller('v1/support')
class SupportController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(OPEN) private readonly open: M7SupportApiOptions['open'],
    @Inject(SEND) private readonly send: M7SupportApiOptions['send'],
  ) {}
  @Post('threads')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async openThread(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<UserSupportReceipt> {
    const actor = await this.boundary.actor(request, 'user');
    const command = this.boundary.parse<OpenSupportThreadCommand>(
      OpenSupportThreadCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(UserSupportReceiptSchema, async () =>
      receipt(await this.open.execute(command)),
    );
  }
  @Post('messages')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async sendMessage(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<UserSupportReceipt> {
    const actor = await this.boundary.actor(request, 'user');
    const command = this.boundary.parse<SendSupportMessageCommand>(
      SendSupportMessageCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(UserSupportReceiptSchema, async () =>
      receipt(await this.send.execute(command)),
    );
  }
}
/** A trusted verifier is required even for restricted-account safety contact. */
@Module({})
export class M7SupportApiModule {
  public static register(options: M7SupportApiOptions): DynamicModule {
    return {
      module: M7SupportApiModule,
      controllers: [SupportController],
      providers: [
        { provide: BOUNDARY, useValue: new M7ApiBoundary(options.authenticator) },
        { provide: OPEN, useValue: options.open },
        { provide: SEND, useValue: options.send },
      ],
    };
  }
}
