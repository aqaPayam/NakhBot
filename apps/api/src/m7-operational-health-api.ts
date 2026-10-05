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
import type {
  PrepareM7OperationalHealthHandler,
  GetM7OperationalHealthHandler,
} from '@nakh/application';
import {
  PrepareM7OperationalHealthQuerySchema,
  PreparedM7OperationalHealthSchema,
  GetM7OperationalHealthQuerySchema,
  M7OperationalHealthSchema,
  type PrepareM7OperationalHealthQuery,
  type GetM7OperationalHealthQuery,
  type PreparedM7OperationalHealth,
  type M7OperationalHealth,
} from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';
const OPTIONS = Symbol('M7_HEALTH_OPTIONS');
export interface M7OperationalHealthApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly prepare: Pick<PrepareM7OperationalHealthHandler, 'execute'>;
  readonly get: Pick<GetM7OperationalHealthHandler, 'execute'>;
}
@Controller('v1/admin/moderation/operational-health')
class OperationalHealthController {
  private readonly boundary: M7ApiBoundary;
  public constructor(@Inject(OPTIONS) private readonly options: M7OperationalHealthApiOptions) {
    this.boundary = new M7ApiBoundary(options.authenticator);
  }
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async prepare(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedM7OperationalHealth> {
    const actor = await this.boundary.actor(request, 'admin');
    const query = this.boundary.parse<PrepareM7OperationalHealthQuery>(
      PrepareM7OperationalHealthQuerySchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedM7OperationalHealthSchema, async () => {
      const result = await this.options.prepare.execute(query, actor);
      const refreshed = await this.boundary.actor(request, 'admin');
      if (refreshed.userId !== actor.userId)
        throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
      return result;
    });
  }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async get(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<M7OperationalHealth> {
    const actor = await this.boundary.actor(request, 'admin');
    const query = this.boundary.parse<GetM7OperationalHealthQuery>(
      GetM7OperationalHealthQuerySchema,
      body,
      actor,
    );
    return this.boundary.result(M7OperationalHealthSchema, async () => {
      const result = await this.options.get.execute(query, actor);
      const refreshed = await this.boundary.actor(request, 'admin');
      if (refreshed.userId !== actor.userId)
        throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
      return result;
    });
  }
}
/** Explicit registration requires a trusted current admin-session/MFA verifier. */
@Module({})
export class M7OperationalHealthApiModule {
  public static register(options: M7OperationalHealthApiOptions): DynamicModule {
    return {
      module: M7OperationalHealthApiModule,
      controllers: [OperationalHealthController],
      providers: [{ provide: OPTIONS, useValue: options }],
    };
  }
}
