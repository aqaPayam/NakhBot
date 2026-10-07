import {
  Body,
  Controller,
  Inject,
  Module,
  Post,
  Req,
  Res,
  HttpCode,
  type DynamicModule,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AdminTotpEnrollments, AdminSessionService } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import {
  AdminTotpBeginSchema,
  AdminTotpConfirmSchema,
  AdminTotpSignInSchema,
  AdminSessionLogoutSchema,
  AdminTotpBeginResultSchema,
  AdminTotpConfirmResultSchema,
  AdminSessionResultSchema,
  AdminSessionLogoutResultSchema,
  type AdminTotpSignIn,
  type AdminSessionLogout,
} from '@nakh/contracts';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';

const OPTIONS = Symbol('M7_TOTP_OPTIONS');
export interface M7TotpApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly enrollments: AdminTotpEnrollments;
  readonly sessions: Pick<AdminSessionService, 'issue' | 'revoke'>;
  /** Native identity lookup, bound to the authenticated user; never supplied by a client. */
  readonly telegramIdentity: (actorUserId: string) => Promise<string | undefined>;
}
function privateResponse(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
}
@Controller('v1/admin/auth')
class TotpController {
  private readonly boundary: M7ApiBoundary;
  public constructor(@Inject(OPTIONS) private readonly options: M7TotpApiOptions) {
    this.boundary = new M7ApiBoundary(options.authenticator);
  }
  @Post('enrollment')
  @HttpCode(200)
  public async begin(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): ReturnType<AdminTotpEnrollments['begin']> {
    privateResponse(reply);
    const actor = await this.boundary.actor(request, 'user');
    const command = this.boundary.parse<Parameters<AdminTotpEnrollments['begin']>[0]>(
      AdminTotpBeginSchema,
      body,
      actor,
    );
    return this.boundary.result(AdminTotpBeginResultSchema, () =>
      this.options.enrollments.begin(command),
    );
  }
  @Post('enrollment/confirm')
  @HttpCode(200)
  public async confirm(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): ReturnType<AdminTotpEnrollments['confirm']> {
    privateResponse(reply);
    const actor = await this.boundary.actor(request, 'user');
    const command = this.boundary.parse<Parameters<AdminTotpEnrollments['confirm']>[0]>(
      AdminTotpConfirmSchema,
      body,
      actor,
    );
    return this.boundary.result(AdminTotpConfirmResultSchema, () =>
      this.options.enrollments.confirm(command),
    );
  }
  @Post('sessions')
  @HttpCode(200)
  public async signIn(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): ReturnType<AdminSessionService['issue']> {
    privateResponse(reply);
    const actor = await this.boundary.actor(request, 'user');
    const command = this.boundary.parse<AdminTotpSignIn>(AdminTotpSignInSchema, body, actor);
    return this.boundary.result(AdminSessionResultSchema, async () => {
      const telegramUserId = await this.options.telegramIdentity(actor.userId);
      if (telegramUserId === undefined)
        throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
      return this.options.sessions.issue({
        actor,
        telegramUserId,
        requestId: command.requestId,
        proof: command.code,
      });
    });
  }
  @Post('sessions/logout')
  @HttpCode(200)
  public async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<Readonly<{ status: 'revoked' }>> {
    privateResponse(reply);
    const actor = await this.boundary.actor(request, 'admin');
    const command = this.boundary.parse<AdminSessionLogout>(AdminSessionLogoutSchema, body, actor);
    return this.boundary.result(AdminSessionLogoutResultSchema, async () => {
      // The boundary has validated this exact header and authenticated its current native owner.
      const adminSessionToken = String(request.headers.authorization).slice(7);
      await this.options.sessions.revoke({
        actor,
        adminSessionToken,
        requestId: command.requestId,
      });
      return { status: 'revoked' as const };
    });
  }
}
/** Explicit opt-in; contains no operator provisioning or recovery route. */
@Module({})
export class M7TotpApiModule {
  public static register(options: M7TotpApiOptions): DynamicModule {
    return {
      module: M7TotpApiModule,
      controllers: [TotpController],
      providers: [{ provide: OPTIONS, useValue: options }],
    };
  }
}
