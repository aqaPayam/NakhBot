import { createHash } from 'node:crypto';
import {
  ApplicationError,
  normalizeAdminReason,
  type Actor,
  type IdGenerator,
  type M7Permission,
} from '@nakh/domain';
import type {
  AdminActionAuthorizationService,
  AuthorizedAdminAction,
} from './admin-authorization.js';
import type { AdminConfirmationTokens } from './admin-confirmation.js';
import type { AdminCommandAttempt } from './admin-command.js';

export type AdminCommandDraft = Readonly<{
  actor: Actor;
  commandId: string;
  requestId: string;
  commandType: string;
  data: Readonly<{ adminActionToken: string; expectedTargetVersion: number; reason: string }>;
}>;
export type ConfirmationScope = Readonly<{
  permission: M7Permission;
  targetType: string;
  payload: readonly unknown[];
}>;
export type ConfirmableDraft<T extends AdminCommandDraft> = Omit<T, 'data'> & {
  data: Omit<T['data'], 'confirmationToken'>;
};
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function assertActor(command: AdminCommandDraft, actor: Actor): void {
  if (
    actor.kind !== 'admin' ||
    command.actor.kind !== 'admin' ||
    command.actor.userId !== actor.userId
  )
    throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
}
function binding(
  command: AdminCommandDraft,
  action: AuthorizedAdminAction,
  scope: ConfirmationScope,
  reason: string,
): string {
  return hash([
    command.commandType,
    command.commandId,
    action.adminUserId,
    action.actorUserId,
    command.data.adminActionToken,
    action.targetId,
    command.data.expectedTargetVersion,
    scope.permission,
    scope.targetType,
    reason,
    scope.payload,
    ...(action.sourceReportId === undefined ? [] : [action.sourceReportId]),
  ]);
}
/** Internal shared boundary; wrappers supply fixed permission/target scopes, never transport input. */
export class ConfirmedAdminCommandBoundary {
  public constructor(
    private readonly authorization: Pick<
      AdminActionAuthorizationService,
      'authorize' | 'resolveAttempt'
    >,
    private readonly confirmations: Pick<AdminConfirmationTokens, 'issue' | 'matches'>,
    private readonly ids: IdGenerator,
    private readonly now: () => number = Date.now,
  ) {}
  public async prepare(
    command: AdminCommandDraft,
    actor: Actor,
    scope: ConfirmationScope,
  ): Promise<string> {
    assertActor(command, actor);
    const action = await this.authorization.authorize({
      actor,
      token: command.data.adminActionToken,
      commandCode: command.commandType,
      requiredPermission: scope.permission,
      targetType: scope.targetType,
    });
    if (
      action.targetId === null ||
      action.expectedTargetVersion !== command.data.expectedTargetVersion
    )
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    return this.confirmations.issue(
      binding(command, action, scope, normalizeAdminReason(command.data.reason)),
    );
  }
  public async resolve(
    command: AdminCommandDraft & {
      data: AdminCommandDraft['data'] & { confirmationToken: string };
    },
    actor: Actor,
    scope: ConfirmationScope,
  ): Promise<Readonly<{ attempt: AdminCommandAttempt; action: AuthorizedAdminAction }>> {
    assertActor(command, actor);
    const action = await this.authorization.resolveAttempt({
      actor,
      token: command.data.adminActionToken,
      commandCode: command.commandType,
      requiredPermission: scope.permission,
      targetType: scope.targetType,
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
    const digest = binding(command, action, scope, reason);
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
    return {
      action,
      attempt: {
        logId: this.ids.uuid(),
        adminUserId: action.adminUserId,
        commandId: command.commandId,
        requestId: command.requestId,
        requestDigest: hash([digest, command.data.confirmationToken]),
        commandCode: command.commandType,
        requiredPermission: scope.permission,
        targetType: scope.targetType,
        targetId: action.targetId,
        ...(action.targetPair === undefined ? {} : { targetPair: action.targetPair }),
        ...(action.sourceReportId === undefined ? {} : { sourceReportId: action.sourceReportId }),
        expectedTargetVersion: command.data.expectedTargetVersion,
        reasonDigest: hash(reason),
        metadata: {},
        correlationId: command.requestId,
        ...(rejection === undefined ? {} : { preconditionRejection: rejection }),
      },
    };
  }
}
