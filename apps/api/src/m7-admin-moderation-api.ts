import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Req,
  type DynamicModule,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  ConfirmedAccountActions,
  RecordAdminIngressRejectionHandler,
  AccountModerationResult,
  ConfirmedPhotoActions,
  PhotoModerationResult,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import {
  AdminCommandReceiptSchema,
  ApplyAccountModerationActionCommandSchema,
  PreparedAdminConfirmationSchema,
  PrepareAccountModerationActionCommandSchema,
  ApplyPhotoModerationActionCommandSchema,
  PreparePhotoModerationActionCommandSchema,
  type ApplyPhotoModerationActionCommand,
  type PreparePhotoModerationActionCommand,
  type PhotoModerationAction,
  type AdminCommandReceipt,
  type ApplyAccountModerationActionCommand,
  type PrepareAccountModerationActionCommand,
  type PreparedAdminConfirmation,
  type AccountModerationAction,
} from '@nakh/contracts';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';
import { AuditedAdminMutationIngress } from './m7-admin-mutation-boundary.js';
import { adminCommandReceipt } from './m7-admin-outcome.js';

const BOUNDARY = Symbol('M7_MODERATION_BOUNDARY'),
  INGRESS = Symbol('M7_MODERATION_INGRESS'),
  ACCOUNTS = Symbol('M7_MODERATION_ACCOUNTS'),
  PHOTOS = Symbol('M7_MODERATION_PHOTOS');
export interface M7AdminModerationApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly journal: Pick<RecordAdminIngressRejectionHandler, 'record' | 'recover'>;
  readonly accounts?: Pick<ConfirmedAccountActions, 'prepare' | 'execute'>;
  readonly photos?: Pick<ConfirmedPhotoActions, 'prepare' | 'execute'>;
}
function accountAction(value: string): AccountModerationAction {
  switch (value) {
    case 'restrict_user':
    case 'unrestrict_user':
    case 'ban_user':
    case 'unban_user':
      return value;
    default:
      throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
  }
}
@Controller('v1/admin/moderation/accounts')
class AccountActionsController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(INGRESS) private readonly ingress: AuditedAdminMutationIngress,
    @Inject(ACCOUNTS)
    private readonly accounts: NonNullable<M7AdminModerationApiOptions['accounts']>,
  ) {}
  @Post(':action/prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async prepare(
    @Param('action') selected: string,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedAdminConfirmation> {
    const actor = await this.boundary.actor(request, 'admin');
    const command = this.boundary.parse<PrepareAccountModerationActionCommand>(
      PrepareAccountModerationActionCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedAdminConfirmationSchema, async () => {
      if (command.data.action !== accountAction(selected))
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      return { confirmationToken: await this.accounts.prepare(command, actor) };
    });
  }
  @Post(':action')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async apply(
    @Param('action') selected: string,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AdminCommandReceipt> {
    return this.boundary.result(AdminCommandReceiptSchema, async () => {
      const action = accountAction(selected);
      const result = await this.ingress.execute<
        ApplyAccountModerationActionCommand,
        AccountModerationResult
      >(
        ApplyAccountModerationActionCommandSchema,
        request,
        body,
        { commandCode: 'moderation.apply-account-action', requiredPermission: action },
        (command, actor) => {
          if (command.data.action !== action)
            throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
          return this.accounts.execute(command, actor);
        },
      );
      return adminCommandReceipt(result);
    });
  }
}
/** Trusted host registration supplies owned workflows and a mandatory failure journal. */
function photoAction(value: string): PhotoModerationAction {
  switch (value) {
    case 'hide_photo':
    case 'restore_photo':
    case 'delete_photo':
      return value;
    default:
      throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
  }
}
@Controller('v1/admin/moderation/photos')
class PhotoActionsController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(INGRESS) private readonly ingress: AuditedAdminMutationIngress,
    @Inject(PHOTOS) private readonly photos: NonNullable<M7AdminModerationApiOptions['photos']>,
  ) {}
  @Post(':action/prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async prepare(
    @Param('action') selected: string,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedAdminConfirmation> {
    const actor = await this.boundary.actor(request, 'admin');
    const command = this.boundary.parse<PreparePhotoModerationActionCommand>(
      PreparePhotoModerationActionCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedAdminConfirmationSchema, async () => {
      if (command.data.action !== photoAction(selected))
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      return { confirmationToken: await this.photos.prepare(command, actor) };
    });
  }
  @Post(':action')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async apply(
    @Param('action') selected: string,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AdminCommandReceipt> {
    return this.boundary.result(AdminCommandReceiptSchema, async () => {
      const action = photoAction(selected);
      const result = await this.ingress.execute<
        ApplyPhotoModerationActionCommand,
        PhotoModerationResult
      >(
        ApplyPhotoModerationActionCommandSchema,
        request,
        body,
        { commandCode: 'moderation.apply-photo-action', requiredPermission: action },
        (command, actor) => {
          if (command.data.action !== action)
            throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
          return this.photos.execute(command, actor);
        },
      );
      return adminCommandReceipt(result);
    });
  }
}
@Module({})
export class M7AdminModerationApiModule {
  public static register(options: M7AdminModerationApiOptions): DynamicModule {
    const boundary = new M7ApiBoundary(options.authenticator);
    return {
      module: M7AdminModerationApiModule,
      controllers: [
        ...(options.accounts === undefined ? [] : [AccountActionsController]),
        ...(options.photos === undefined ? [] : [PhotoActionsController]),
      ],
      providers: [
        { provide: BOUNDARY, useValue: boundary },
        { provide: INGRESS, useValue: new AuditedAdminMutationIngress(boundary, options.journal) },
        ...(options.accounts === undefined
          ? []
          : [{ provide: ACCOUNTS, useValue: options.accounts }]),
        ...(options.photos === undefined ? [] : [{ provide: PHOTOS, useValue: options.photos }]),
      ],
    };
  }
}
