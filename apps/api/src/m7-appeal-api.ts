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
import type { PrepareAppealHandler, SubmitAppealHandler } from '@nakh/application';
import {
  PrepareAppealQuerySchema,
  PreparedAppealReferenceSchema,
  SubmitAppealCommandSchema,
  UserAppealReceiptSchema,
  type PrepareAppealQuery,
  type PreparedAppealReference,
  type SubmitAppealCommand,
  type UserAppealReceipt,
} from '@nakh/contracts';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';
const BOUNDARY = Symbol('M7_APPEAL_BOUNDARY'),
  PREPARE = Symbol('M7_APPEAL_PREPARE'),
  SUBMIT = Symbol('M7_APPEAL_SUBMIT');
export interface M7AppealApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly prepare: Pick<PrepareAppealHandler, 'execute'>;
  readonly submit: Pick<SubmitAppealHandler, 'execute'>;
}
@Controller('v1/appeals')
class AppealController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(PREPARE) private readonly prepare: M7AppealApiOptions['prepare'],
    @Inject(SUBMIT) private readonly submit: M7AppealApiOptions['submit'],
  ) {}
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async reference(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedAppealReference> {
    const actor = await this.boundary.actor(request, 'user');
    const query = this.boundary.parse<PrepareAppealQuery>(PrepareAppealQuerySchema, body, actor);
    return this.boundary.result(PreparedAppealReferenceSchema, async () => ({
      banActionToken: await this.prepare.execute(actor.userId, query.commandId),
    }));
  }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async appeal(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<UserAppealReceipt> {
    const actor = await this.boundary.actor(request, 'user');
    const command = this.boundary.parse<SubmitAppealCommand>(
      SubmitAppealCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(UserAppealReceiptSchema, async () => {
      const result = await this.submit.execute(command);
      return {
        status: result.status,
        version: result.version,
        changedAt: result.changedAt,
        replayed: result.replayed,
      };
    });
  }
}
@Module({})
export class M7AppealApiModule {
  public static register(options: M7AppealApiOptions): DynamicModule {
    return {
      module: M7AppealApiModule,
      controllers: [AppealController],
      providers: [
        { provide: BOUNDARY, useValue: new M7ApiBoundary(options.authenticator) },
        { provide: PREPARE, useValue: options.prepare },
        { provide: SUBMIT, useValue: options.submit },
      ],
    };
  }
}
