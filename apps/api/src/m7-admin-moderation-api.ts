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
  ClaimModerationReviewsHandler,
  ClaimedModerationReview,
  ConfirmedAccountActions,
  RecordAdminIngressRejectionHandler,
  AccountModerationResult,
  ConfirmedPhotoActions,
  PhotoModerationResult,
  ConfirmedInternalBlocks,
  InternalBlockResult,
  ConfirmedReviewAssignments,
  AssignedModerationReview,
  ConfirmedReviewDecisions,
  ReviewDecisionResult,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import {
  ClaimModerationReviewsCommandSchema,
  AdminReviewClaimResultSchema,
  type ClaimModerationReviewsCommand,
  type AdminReviewClaimResult,
  AdminCommandReceiptSchema,
  ApplyAccountModerationActionCommandSchema,
  PreparedAdminConfirmationSchema,
  PrepareAccountModerationActionCommandSchema,
  ApplyPhotoModerationActionCommandSchema,
  PreparePhotoModerationActionCommandSchema,
  ChangeInternalBlockCommandSchema,
  PrepareInternalBlockCommandSchema,
  AssignModerationReviewCommandSchema,
  PrepareReviewAssignmentCommandSchema,
  DecideModerationReviewCommandSchema,
  PrepareReviewDecisionCommandSchema,
  type DecideModerationReviewCommand,
  type PrepareReviewDecisionCommand,
  type AssignModerationReviewCommand,
  type PrepareReviewAssignmentCommand,
  type ChangeInternalBlockCommand,
  type PrepareInternalBlockCommand,
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
  PHOTOS = Symbol('M7_MODERATION_PHOTOS'),
  BLOCKS = Symbol('M7_MODERATION_BLOCKS'),
  ASSIGNMENTS = Symbol('M7_REVIEW_ASSIGNMENTS'),
  DECISIONS = Symbol('M7_REVIEW_DECISIONS'),
  CLAIMS = Symbol('M7_REVIEW_CLAIMS');
export interface M7AdminModerationApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly journal: Pick<RecordAdminIngressRejectionHandler, 'record' | 'recover'>;
  readonly accounts?: Pick<ConfirmedAccountActions, 'prepare' | 'execute'>;
  readonly photos?: Pick<ConfirmedPhotoActions, 'prepare' | 'execute'>;
  readonly internalBlocks?: Pick<ConfirmedInternalBlocks, 'prepare' | 'execute'>;
  readonly reviewAssignments?: Pick<ConfirmedReviewAssignments, 'prepare' | 'execute'>;
  readonly reviewDecisions?: Pick<ConfirmedReviewDecisions, 'prepare' | 'execute'>;
  readonly reviewClaims?: Pick<ClaimModerationReviewsHandler, 'execute'>;
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
function blockAction(value: string): 'create' | 'remove' {
  if (value === 'create' || value === 'remove') return value;
  throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
}
@Controller('v1/admin/moderation/internal-blocks')
class InternalBlocksController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(INGRESS) private readonly ingress: AuditedAdminMutationIngress,
    @Inject(BLOCKS)
    private readonly blocks: NonNullable<M7AdminModerationApiOptions['internalBlocks']>,
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
    const command = this.boundary.parse<PrepareInternalBlockCommand>(
      PrepareInternalBlockCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedAdminConfirmationSchema, async () => {
      if (command.data.action !== blockAction(selected))
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      return { confirmationToken: await this.blocks.prepare(command, actor) };
    });
  }
  @Post(':action')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async change(
    @Param('action') selected: string,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AdminCommandReceipt> {
    return this.boundary.result(AdminCommandReceiptSchema, async () => {
      const action = blockAction(selected);
      const result = await this.ingress.execute<ChangeInternalBlockCommand, InternalBlockResult>(
        ChangeInternalBlockCommandSchema,
        request,
        body,
        {
          commandCode: 'moderation.change-internal-block',
          requiredPermission: 'manage_internal_blocks',
        },
        (command, actor) => {
          if (command.data.action !== action)
            throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
          return this.blocks.execute(command, actor);
        },
      );
      return adminCommandReceipt(result);
    });
  }
}
@Controller('v1/admin/moderation/reviews/assignment')
class ReviewAssignmentController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(INGRESS) private readonly ingress: AuditedAdminMutationIngress,
    @Inject(ASSIGNMENTS)
    private readonly assignments: NonNullable<M7AdminModerationApiOptions['reviewAssignments']>,
  ) {}
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async prepare(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedAdminConfirmation> {
    const actor = await this.boundary.actor(request, 'admin');
    const command = this.boundary.parse<PrepareReviewAssignmentCommand>(
      PrepareReviewAssignmentCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedAdminConfirmationSchema, async () => ({
      confirmationToken: await this.assignments.prepare(command, actor),
    }));
  }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async assign(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AdminCommandReceipt> {
    return this.boundary.result(AdminCommandReceiptSchema, async () =>
      adminCommandReceipt(
        await this.ingress.execute<AssignModerationReviewCommand, AssignedModerationReview>(
          AssignModerationReviewCommandSchema,
          request,
          body,
          { commandCode: 'moderation.assign-review', requiredPermission: 'view_reports' },
          (command, actor) => this.assignments.execute(command, actor),
        ),
      ),
    );
  }
}
function reviewDecision(value: string): 'dismissed' | 'actioned' {
  if (value === 'dismissed' || value === 'actioned') return value;
  throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
}
@Controller('v1/admin/moderation/reviews/decision')
class ReviewDecisionController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(INGRESS) private readonly ingress: AuditedAdminMutationIngress,
    @Inject(DECISIONS)
    private readonly decisions: NonNullable<M7AdminModerationApiOptions['reviewDecisions']>,
  ) {}
  @Post(':decision/prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async prepare(
    @Param('decision') selected: string,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedAdminConfirmation> {
    const actor = await this.boundary.actor(request, 'admin');
    const command = this.boundary.parse<PrepareReviewDecisionCommand>(
      PrepareReviewDecisionCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedAdminConfirmationSchema, async () => {
      if (command.data.decision !== reviewDecision(selected))
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      return { confirmationToken: await this.decisions.prepare(command, actor) };
    });
  }
  @Post(':decision')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async decide(
    @Param('decision') selected: string,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AdminCommandReceipt> {
    return this.boundary.result(AdminCommandReceiptSchema, async () => {
      const decision = reviewDecision(selected);
      const result = await this.ingress.execute<
        DecideModerationReviewCommand,
        ReviewDecisionResult
      >(
        DecideModerationReviewCommandSchema,
        request,
        body,
        {
          commandCode: 'moderation.decide-review',
          requiredPermission: decision === 'dismissed' ? 'dismiss_report' : 'view_reports',
        },
        (command, actor) => {
          if (command.data.decision !== decision)
            throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
          return this.decisions.execute(command, actor);
        },
      );
      return adminCommandReceipt(result);
    });
  }
}
@Controller('v1/admin/moderation/reviews/claim')
class ReviewClaimController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(INGRESS) private readonly ingress: AuditedAdminMutationIngress,
    @Inject(CLAIMS)
    private readonly claims: NonNullable<M7AdminModerationApiOptions['reviewClaims']>,
  ) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async claim(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AdminReviewClaimResult> {
    return this.boundary.result(AdminReviewClaimResultSchema, async () => {
      const outcome = await this.ingress.execute<
        ClaimModerationReviewsCommand,
        readonly ClaimedModerationReview[]
      >(
        ClaimModerationReviewsCommandSchema,
        request,
        body,
        { commandCode: 'moderation.claim-reviews', requiredPermission: 'view_reports' },
        (command, actor) => this.claims.execute(command, actor),
      );
      const receipt = adminCommandReceipt(outcome);
      if (receipt.result === 'succeeded' && !receipt.replayed) {
        if (outcome.value === undefined)
          throw new ApplicationError('internal_error', 'error.m7.internal', 500);
        return {
          ...receipt,
          result: 'succeeded' as const,
          replayed: false as const,
          claims: outcome.value.map(({ reviewId, reportId, reviewVersion, priority }) => ({
            reviewId,
            reportId,
            reviewVersion,
            priority,
          })),
        };
      }
      if (receipt.result === 'succeeded')
        return { ...receipt, result: 'succeeded' as const, replayed: true as const };
      return { ...receipt, result: receipt.result };
    });
  }
}
/** Trusted host registration supplies owned workflows and a mandatory failure journal. */
@Module({})
export class M7AdminModerationApiModule {
  public static register(options: M7AdminModerationApiOptions): DynamicModule {
    const boundary = new M7ApiBoundary(options.authenticator);
    return {
      module: M7AdminModerationApiModule,
      controllers: [
        ...(options.reviewClaims === undefined ? [] : [ReviewClaimController]),
        ...(options.accounts === undefined ? [] : [AccountActionsController]),
        ...(options.photos === undefined ? [] : [PhotoActionsController]),
        ...(options.internalBlocks === undefined ? [] : [InternalBlocksController]),
        ...(options.reviewAssignments === undefined ? [] : [ReviewAssignmentController]),
        ...(options.reviewDecisions === undefined ? [] : [ReviewDecisionController]),
      ],
      providers: [
        ...(options.reviewClaims === undefined
          ? []
          : [{ provide: CLAIMS, useValue: options.reviewClaims }]),
        { provide: BOUNDARY, useValue: boundary },
        { provide: INGRESS, useValue: new AuditedAdminMutationIngress(boundary, options.journal) },
        ...(options.accounts === undefined
          ? []
          : [{ provide: ACCOUNTS, useValue: options.accounts }]),
        ...(options.photos === undefined ? [] : [{ provide: PHOTOS, useValue: options.photos }]),
        ...(options.internalBlocks === undefined
          ? []
          : [{ provide: BLOCKS, useValue: options.internalBlocks }]),
        ...(options.reviewAssignments === undefined
          ? []
          : [{ provide: ASSIGNMENTS, useValue: options.reviewAssignments }]),
        ...(options.reviewDecisions === undefined
          ? []
          : [{ provide: DECISIONS, useValue: options.reviewDecisions }]),
      ],
    };
  }
}
