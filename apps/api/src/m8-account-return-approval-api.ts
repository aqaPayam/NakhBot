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
  ConfirmedAccountReturnApprovals,
  SelectAccountReturnApprovalHandler,
  RecordAdminIngressRejectionHandler,
  AccountReturnApproval,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import {
  SelectAccountReturnApprovalQuerySchema,
  SelectedAccountReturnApprovalSchema,
  PrepareAccountReturnApprovalCommandSchema,
  ApproveAccountReturnCommandSchema,
  PreparedAdminConfirmationSchema,
  AdminCommandReceiptSchema,
  type SelectAccountReturnApprovalQuery,
  type SelectedAccountReturnApproval,
  type PrepareAccountReturnApprovalCommand,
  type ApproveAccountReturnCommand,
  type PreparedAdminConfirmation,
  type AdminCommandReceipt,
} from '@nakh/contracts';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';
import { AuditedAdminMutationIngress } from './m7-admin-mutation-boundary.js';
import { adminCommandReceipt } from './m7-admin-outcome.js';

export interface M8AccountReturnApprovalApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly selection: Pick<SelectAccountReturnApprovalHandler, 'execute'>;
  readonly commands: Pick<ConfirmedAccountReturnApprovals, 'prepare' | 'execute'>;
  readonly rejections: Pick<RecordAdminIngressRejectionHandler, 'record' | 'recover'>;
}
const OPTIONS = Symbol('M8_RETURN_APPROVAL_OPTIONS');
@Controller('v1/admin/account-returns')
class AccountReturnApprovalController {
  private readonly boundary: M7ApiBoundary;
  private readonly ingress: AuditedAdminMutationIngress;
  public constructor(@Inject(OPTIONS) private readonly options: M8AccountReturnApprovalApiOptions) {
    this.boundary = new M7ApiBoundary(options.authenticator);
    this.ingress = new AuditedAdminMutationIngress(this.boundary, options.rejections);
  }
  @Post('actions')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async select(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<SelectedAccountReturnApproval> {
    const actor = await this.boundary.actor(request, 'admin');
    const query = this.boundary.parse<SelectAccountReturnApprovalQuery>(
      SelectAccountReturnApprovalQuerySchema,
      body,
      actor,
    );
    return this.boundary.result(SelectedAccountReturnApprovalSchema, async () => {
      const result = await this.options.selection.execute(query, actor);
      if ((await this.boundary.actor(request, 'admin')).userId !== actor.userId)
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      return result;
    });
  }
  @Post('approve/prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async prepare(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedAdminConfirmation> {
    const actor = await this.boundary.actor(request, 'admin');
    const command = this.boundary.parse<PrepareAccountReturnApprovalCommand>(
      PrepareAccountReturnApprovalCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedAdminConfirmationSchema, async () => {
      const confirmationToken = await this.options.commands.prepare(command, actor);
      if ((await this.boundary.actor(request, 'admin')).userId !== actor.userId)
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      return { confirmationToken };
    });
  }
  @Post('approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async approve(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AdminCommandReceipt> {
    return this.boundary.result(AdminCommandReceiptSchema, async () =>
      adminCommandReceipt(
        await this.ingress.execute<ApproveAccountReturnCommand, AccountReturnApproval>(
          ApproveAccountReturnCommandSchema,
          request,
          body,
          { commandCode: 'account.approve-return', requiredPermission: 'approve_account_return' },
          (command, actor) => this.options.commands.execute(command, actor),
        ),
      ),
    );
  }
}
/** Explicit native-session host only. No approval value, Root, secret or product credential is returned. */
@Module({})
export class M8AccountReturnApprovalApiModule {
  public static register(options: M8AccountReturnApprovalApiOptions): DynamicModule {
    return {
      module: M8AccountReturnApprovalApiModule,
      controllers: [AccountReturnApprovalController],
      providers: [{ provide: OPTIONS, useValue: options }],
    };
  }
}
