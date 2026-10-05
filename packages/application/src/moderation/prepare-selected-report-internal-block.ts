import type {
  PrepareSelectedReportInternalBlockQuery,
  PreparedReportInternalBlock,
} from '@nakh/contracts';
import {
  ApplicationError,
  canTransitionPairState,
  normalizeUserPair,
  type Actor,
  type UserPairState,
} from '@nakh/domain';
import {
  canonicalAdminPairTargetId,
  type AdminActionAuthorizationService,
} from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';
export interface SelectedReportInternalBlockStore {
  get(reportId: string): Promise<
    | Readonly<{
        reportVersion: number;
        reportStatus: string;
        reporterUserId: string;
        targetUserId: string;
        pairVersion: number;
        pairState: UserPairState | undefined;
      }>
    | undefined
  >;
}
/** Exact Report supplies the normalized pair. No client pair identity or version is authoritative. */
export class PrepareSelectedReportInternalBlockHandler {
  public constructor(
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize' | 'issue'>,
    private readonly identities: AdminQueueIdentityStore,
    private readonly reports: SelectedReportInternalBlockStore,
  ) {}
  public async execute(
    query: PrepareSelectedReportInternalBlockQuery,
    actor: Actor,
  ): Promise<PreparedReportInternalBlock> {
    if (
      actor.kind !== 'admin' ||
      query.actor.kind !== 'admin' ||
      actor.userId !== query.actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
    const root = await this.authorization.authorize({
      actor,
      token: query.adminActionToken,
      commandCode: 'moderation.report-metadata',
      requiredPermission: 'view_reports',
      targetType: 'report_queue',
    });
    if (
      root.targetId !== null ||
      root.expectedTargetVersion !== null ||
      !Number.isSafeInteger(query.expectedReportVersion) ||
      query.expectedReportVersion < 1 ||
      (query.action !== 'create' && query.action !== 'remove')
    )
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const selected = await this.reports.get(query.reportId);
    if (selected === undefined)
      throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
    if (selected.reportVersion !== query.expectedReportVersion)
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    if (
      !['submitted', 'pending_review', 'dismissed', 'actioned', 'closed'].includes(
        selected.reportStatus,
      ) ||
      !Number.isSafeInteger(selected.pairVersion) ||
      selected.pairVersion < 1
    )
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    const pair = normalizeUserPair(selected.reporterUserId, selected.targetUserId);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined || identity.adminUserId !== root.adminUserId)
      throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
    const adminActionToken = await this.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode: 'moderation.change-internal-block',
        requiredPermission: 'manage_internal_blocks',
        targetType: 'user_pair',
        targetId: canonicalAdminPairTargetId(pair),
        targetPair: pair,
        expectedTargetVersion: selected.pairVersion,
        sourceReportId: query.reportId,
      },
    });
    // Specific permission is checked before disclosing pair-state eligibility.
    if (
      !(query.action === 'create'
        ? canTransitionPairState(selected.pairState, 'blocked')
        : canTransitionPairState(selected.pairState, undefined, true))
    )
      throw new ApplicationError('moderation_state_invalid', 'error.m7.unavailable', 409);
    const current = await this.reports.get(query.reportId);
    if (
      current === undefined ||
      current.reportVersion !== selected.reportVersion ||
      current.reportStatus !== selected.reportStatus ||
      current.reporterUserId !== selected.reporterUserId ||
      current.targetUserId !== selected.targetUserId ||
      current.pairVersion !== selected.pairVersion ||
      current.pairState !== selected.pairState
    )
      throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
    await this.authorization.authorize({
      actor,
      token: adminActionToken,
      commandCode: 'moderation.change-internal-block',
      requiredPermission: 'manage_internal_blocks',
      targetType: 'user_pair',
    });
    return { adminActionToken, pairVersion: selected.pairVersion };
  }
}
