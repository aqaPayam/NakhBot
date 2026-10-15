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
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import type {
  AccountControlSessionService,
  AccountReturnActor,
  AccountReturnStore,
} from '@nakh/application';
import { isAccountControlLife } from '@nakh/application';
import {
  ReturnAccountCommandSchema,
  ReturnAccountResultSchema,
  type ReturnAccountResult,
} from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

export interface M8AccountReturnApiOptions {
  readonly controls: Pick<AccountControlSessionService, 'authenticateReturn'>;
  readonly store: (actor: AccountReturnActor) => AccountReturnStore;
}
const OPTIONS = Symbol('M8_ACCOUNT_RETURN');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;

@Controller('v1/account/return')
class AccountReturnController {
  private readonly command;
  private readonly result;
  public constructor(@Inject(OPTIONS) private readonly options: M8AccountReturnApiOptions) {
    const ajv = addFormats(new Ajv({ allErrors: false }));
    this.command = ajv.compile(ReturnAccountCommandSchema);
    this.result = ajv.compile(ReturnAccountResultSchema);
  }
  @Post('confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async confirm(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ReturnAccountResult> {
    try {
      const header = request.headers.authorization;
      const bearer =
        typeof header === 'string' && header.length <= 4103
          ? /^Bearer ([A-Za-z0-9._~-]{16,4096})$/u.exec(header)
          : null;
      if (bearer === null)
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        'actor' in body ||
        'channelContext' in body
      )
        throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
      // Capture the received command before native authentication waits. The client
      // supplies no identity, grant, proof, Root, approval or epoch selector.
      const captured = structuredClone(body);
      const issued = await this.options.controls.authenticateReturn({
        bearerToken: bearer[1]!,
        audience: 'account_return',
      });
      if (
        !isAccountControlLife(issued) ||
        issued?.kind !== 'user' ||
        issued.scope !== 'account_return' ||
        !UUID.test(issued.controlGrantId)
      )
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      const actor: AccountReturnActor = Object.freeze({
        kind: 'user',
        scope: 'account_return',
        userId: issued.userId,
        productEpoch: issued.productEpoch,
        controlGrantId: issued.controlGrantId,
      });
      const input = { ...captured, actor: { kind: 'user', userId: actor.userId } };
      if (!this.command(input))
        throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
      const result = await this.options.store(actor).return(input);
      // General control authentication must remain invalid after the epoch moves.
      // Only the same original grant's verified Return receipt permits this check.
      const current = await this.options.controls.authenticateReturn({
        bearerToken: bearer[1]!,
        audience: 'account_return',
      });
      if (
        current?.kind !== 'user' ||
        current.scope !== 'account_return' ||
        current.userId !== actor.userId ||
        current.productEpoch !== actor.productEpoch ||
        current.controlGrantId !== actor.controlGrantId
      )
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      if (!this.result(result)) throw new Error('Invalid Return result');
      return result;
    } catch (error) {
      if (error instanceof ApplicationError && error.status >= 400 && error.status < 500)
        throw new ApplicationError(error.code, 'error.deletion.unavailable', error.status);
      throw new ApplicationError('internal_error', 'error.deletion.unavailable', 500);
    }
  }
}
@Module({})
export class M8AccountReturnApiModule {
  public static register(options: M8AccountReturnApiOptions): DynamicModule {
    return {
      module: M8AccountReturnApiModule,
      controllers: [AccountReturnController],
      providers: [{ provide: OPTIONS, useValue: options }],
    };
  }
}
