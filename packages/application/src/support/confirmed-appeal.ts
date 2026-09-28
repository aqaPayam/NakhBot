import { createHash } from 'node:crypto';

import type { AppealResult, ReviewAppealCommand, UnbanAppealCommand } from '@nakh/contracts';
import { ApplicationError, normalizeAdminReason, type Actor, type IdGenerator } from '@nakh/domain';

import type {
  AdminActionAuthorizationService,
  AuthorizedAdminAction,
} from '../administration/admin-authorization.js';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
} from '../administration/admin-command.js';
import type { AdminConfirmationTokens } from '../administration/admin-confirmation.js';
import type { AccountModerationResult } from '../moderation/account-action.js';
import type { AppealReviewWorkflow } from './appeal-review.js';
import type { AppealUnbanWorkflow } from './appeal-unban.js';

type Draft<T extends ReviewAppealCommand | UnbanAppealCommand> = Omit<T, 'data'> & {
  data: Omit<T['data'], 'confirmationToken'>;
};
export type AppealAdminDraft = Draft<ReviewAppealCommand> | Draft<UnbanAppealCommand>;
type Command = ReviewAppealCommand | UnbanAppealCommand;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function permission(command: AppealAdminDraft): 'review_appeals' | 'unban_user' {
  return command.commandType === 'moderation.review-appeal' ? 'review_appeals' : 'unban_user';
}
function assertActor(command: AppealAdminDraft, actor: Actor): void {
  if (actor.kind !== 'admin' || command.actor.userId !== actor.userId)
    throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
}
function binding(command: AppealAdminDraft, action: AuthorizedAdminAction, reason: string): string {
  const payload =
    command.commandType === 'moderation.review-appeal'
      ? [command.data.decision, command.data.note ?? null]
      : [command.data.expectedAccountVersion];
  return hash([
    command.commandType,
    command.commandId,
    action.adminUserId,
    action.actorUserId,
    command.data.adminActionToken,
    action.targetId,
    command.data.expectedTargetVersion,
    reason,
    payload,
  ]);
}

/** Transport-neutral boundary. The actor argument must come from authenticated ingress. */
export class ConfirmedAppealCommands {
  public constructor(
    private readonly authorization: Pick<
      AdminActionAuthorizationService,
      'authorize' | 'resolveAttempt'
    >,
    private readonly confirmations: Pick<AdminConfirmationTokens, 'issue' | 'matches'>,
    private readonly reviews: Pick<AppealReviewWorkflow<never>, 'review'>,
    private readonly unbans: Pick<AppealUnbanWorkflow<never>, 'unban'>,
    private readonly ids: IdGenerator,
    private readonly now: () => number = Date.now,
  ) {}

  public async prepare(command: AppealAdminDraft, actor: Actor): Promise<string> {
    assertActor(command, actor);
    const action = await this.authorization.authorize({
      actor,
      token: command.data.adminActionToken,
      commandCode: command.commandType,
      requiredPermission: permission(command),
      targetType: 'user_appeal',
    });
    if (
      action.targetId === null ||
      action.expectedTargetVersion !== command.data.expectedTargetVersion
    )
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    return this.confirmations.issue(
      binding(command, action, normalizeAdminReason(command.data.reason)),
    );
  }

  public async execute(
    command: Command,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<AppealResult | AccountModerationResult>> {
    assertActor(command, actor);
    // Recover signed claims even for a now-disabled admin, then let the database audit its denial.
    const action = await this.authorization.resolveAttempt({
      actor,
      token: command.data.adminActionToken,
      commandCode: command.commandType,
      requiredPermission: permission(command),
      targetType: 'user_appeal',
    });
    if (action.targetId === null)
      throw new ApplicationError('invalid_request', 'error.admin.action_scope_invalid', 400);
    let rejection: AdminCommandAttempt['preconditionRejection'];
    let reason = command.data.reason;
    try {
      reason = normalizeAdminReason(reason);
    } catch {
      rejection = 'admin_reason_invalid';
    }
    const digest = binding(command, action, reason);
    if (
      action.expiresAt <= this.now() ||
      action.expectedTargetVersion !== command.data.expectedTargetVersion
    )
      rejection = 'version_conflict';
    if (
      rejection === undefined &&
      !(await this.confirmations.matches(command.data.confirmationToken, digest))
    )
      rejection = 'invalid_request';
    const attempt: AdminCommandAttempt = {
      logId: this.ids.uuid(),
      adminUserId: action.adminUserId,
      commandId: command.commandId,
      requestId: command.requestId,
      requestDigest: hash([digest, command.data.confirmationToken]),
      commandCode: command.commandType,
      requiredPermission: permission(command),
      targetType: 'user_appeal',
      targetId: action.targetId,
      expectedTargetVersion: command.data.expectedTargetVersion,
      reasonDigest: hash(reason),
      metadata: {},
      correlationId: command.requestId,
      ...(rejection === undefined ? {} : { preconditionRejection: rejection }),
    };
    return command.commandType === 'moderation.review-appeal'
      ? this.reviews.review(attempt, command.data.decision, command.data.note)
      : this.unbans.unban(attempt, command.data.expectedAccountVersion);
  }
}
