import type {
  ApproveAccountReturnCommand,
  PrepareAccountReturnApprovalCommand,
  SelectAccountReturnApprovalQuery,
  SelectedAccountReturnApproval,
} from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type {
  AdminActionAuthorizationService,
  AdminAuthorizationStore,
} from '../administration/admin-authorization.js';
import type { ConfirmedAdminCommandBoundary } from '../administration/confirmed-command.js';
import type { AdminCommandExecutionResult } from '../administration/admin-command.js';
import type { AdminQueueIdentityStore } from '../moderation/queue-actions.js';
import type {
  AccountReturnApproval,
  AccountReturnApprovalWorkflow,
} from './account-return-approval.js';

const scope = {
  permission: 'approve_account_return',
  targetType: 'account_deletion',
  payload: [],
} as const;
export interface AccountReturnApprovalSelectionStore {
  get(rootId: string): Promise<Readonly<{ version: number; reviewable: boolean }> | undefined>;
}
function unavailable(): ApplicationError {
  return new ApplicationError('forbidden', 'error.deletion.unavailable', 403);
}
/** Selection never approves or returns an account; every later stage rechecks authority. */
export class SelectAccountReturnApprovalHandler {
  public constructor(
    private readonly identities: AdminQueueIdentityStore,
    private readonly facts: AdminAuthorizationStore,
    private readonly authorization: Pick<AdminActionAuthorizationService, 'issue' | 'authorize'>,
    private readonly roots: AccountReturnApprovalSelectionStore,
  ) {}
  public async execute(
    query: SelectAccountReturnApprovalQuery,
    actor: Actor,
  ): Promise<SelectedAccountReturnApproval> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      actor.userId !== query.actor.userId
    )
      throw unavailable();
    const rootId = query.deletionRecordId,
      expectedVersion = query.expectedTargetVersion;
    const admin = Object.freeze({ kind: 'admin' as const, userId: actor.userId });
    const identity = await this.identities.get(admin.userId);
    if (identity === undefined) throw unavailable();
    const facts = await this.facts.loadCurrent({
      adminUserId: identity.adminUserId,
      actorUserId: admin.userId,
    });
    if (
      facts?.adminActive !== true ||
      facts.adminUserId !== identity.adminUserId ||
      facts.actorUserId !== admin.userId ||
      !facts.activePermissions.includes('approve_account_return')
    )
      throw unavailable();
    const root = await this.roots.get(rootId);
    if (root?.reviewable !== true)
      throw new ApplicationError('conflict', 'error.deletion.unavailable', 409);
    if (root.version !== expectedVersion)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
    const adminActionToken = await this.authorization.issue({
      actorUserId: admin.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode: 'account.approve-return',
        requiredPermission: 'approve_account_return',
        targetType: 'account_deletion',
        targetId: rootId,
        expectedTargetVersion: root.version,
      },
    });
    const current = await this.roots.get(rootId);
    if (current?.reviewable !== true || current.version !== root.version)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
    await this.authorization.authorize({
      actor: admin,
      token: adminActionToken,
      commandCode: 'account.approve-return',
      requiredPermission: 'approve_account_return',
      targetType: 'account_deletion',
    });
    return { adminActionToken, expectedTargetVersion: root.version };
  }
}
export class ConfirmedAccountReturnApprovals {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly workflow: Pick<AccountReturnApprovalWorkflow<never>, 'approve'>,
  ) {}
  public prepare(command: PrepareAccountReturnApprovalCommand, actor: Actor): Promise<string> {
    return this.boundary.prepare(
      Object.freeze({
        ...command,
        actor: Object.freeze({ ...command.actor }),
        data: Object.freeze({ ...command.data }),
      }),
      Object.freeze({ ...actor }),
      scope,
    );
  }
  public async execute(
    command: ApproveAccountReturnCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<AccountReturnApproval>> {
    const { attempt } = await this.boundary.resolve(
      Object.freeze({
        ...command,
        actor: Object.freeze({ ...command.actor }),
        data: Object.freeze({ ...command.data }),
      }),
      Object.freeze({ ...actor }),
      scope,
    );
    return this.workflow.approve(attempt);
  }
}
