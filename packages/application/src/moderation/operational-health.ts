import type {
  PrepareM7OperationalHealthQuery,
  PreparedM7OperationalHealth,
  GetM7OperationalHealthQuery,
  M7OperationalHealth,
} from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type {
  AdminAuthorizationStore,
  AdminActionAuthorizationService,
} from '../administration/admin-authorization.js';
import type { AdminQueueIdentityStore } from './queue-actions.js';

/** One global view spans all three read domains. Role names never grant this authority. */
export const M7_OPERATIONAL_HEALTH_PERMISSIONS = [
  'view_reports',
  'review_support',
  'review_appeals',
] as const;
export const M7_OPERATIONAL_HEALTH_NUMERIC_FIELDS = [
  'oldestPendingReportAgeSeconds',
  'oldestInReviewAgeSeconds',
  'thresholdMismatchCount',
  'adminLogMismatchCount',
  'snapshotIntegrityFailureCount',
  'supportLimitMismatchCount',
  'appealUniquenessMismatchCount',
] as const;
export interface M7OperationalHealthStore {
  measure(): Promise<M7OperationalHealth>;
}
function denied(): ApplicationError {
  return new ApplicationError('forbidden', 'error.m7.unavailable', 403);
}
function actorMatches(actor: Actor, supplied: Actor): void {
  if (actor.kind !== 'admin' || supplied.kind !== 'admin' || actor.userId !== supplied.userId)
    throw new ApplicationError('unauthorized', 'error.admin.unauthorized', 401);
}
async function requirePermissions(
  store: AdminAuthorizationStore,
  adminUserId: string,
  actorUserId: string,
): Promise<void> {
  const facts = await store.loadCurrent({ adminUserId, actorUserId });
  if (
    facts === undefined ||
    !facts.adminActive ||
    facts.adminUserId !== adminUserId ||
    facts.actorUserId !== actorUserId ||
    !Array.isArray(facts.activePermissions) ||
    !M7_OPERATIONAL_HEALTH_PERMISSIONS.every((permission) =>
      facts.activePermissions.includes(permission),
    )
  )
    throw denied();
}
export class PrepareM7OperationalHealthHandler {
  public constructor(
    private readonly identities: AdminQueueIdentityStore,
    private readonly facts: AdminAuthorizationStore,
    private readonly authorization: Pick<AdminActionAuthorizationService, 'issue'>,
  ) {}
  public async execute(
    query: PrepareM7OperationalHealthQuery,
    actor: Actor,
  ): Promise<PreparedM7OperationalHealth> {
    actorMatches(actor, query.actor);
    const identity = await this.identities.get(actor.userId);
    if (identity === undefined) throw denied();
    await requirePermissions(this.facts, identity.adminUserId, actor.userId);
    const adminActionToken = await this.authorization.issue({
      actorUserId: actor.userId,
      telegramUserId: identity.telegramUserId,
      scope: {
        commandCode: 'moderation.operational-health',
        requiredPermission: 'view_reports',
        targetType: 'moderation_health',
        targetId: null,
        expectedTargetVersion: null,
      },
    });
    await requirePermissions(this.facts, identity.adminUserId, actor.userId);
    return { adminActionToken };
  }
}
export class GetM7OperationalHealthHandler {
  public constructor(
    private readonly facts: AdminAuthorizationStore,
    private readonly authorization: Pick<AdminActionAuthorizationService, 'authorize'>,
    private readonly health: M7OperationalHealthStore,
  ) {}
  public async execute(
    query: GetM7OperationalHealthQuery,
    actor: Actor,
  ): Promise<M7OperationalHealth> {
    actorMatches(actor, query.actor);
    const input = {
      actor,
      token: query.adminActionToken,
      commandCode: 'moderation.operational-health',
      requiredPermission: 'view_reports' as const,
      targetType: 'moderation_health',
    };
    const access = await this.authorization.authorize(input);
    if (
      access.targetId !== null ||
      access.expectedTargetVersion !== null ||
      access.sourceReportId !== undefined ||
      access.targetPair !== undefined
    )
      throw denied();
    await requirePermissions(this.facts, access.adminUserId, actor.userId);
    const sample = await this.health.measure();
    const refreshed = await this.authorization.authorize(input);
    if (
      refreshed.adminUserId !== access.adminUserId ||
      refreshed.targetId !== null ||
      refreshed.expectedTargetVersion !== null ||
      refreshed.sourceReportId !== undefined ||
      refreshed.targetPair !== undefined
    )
      throw denied();
    await requirePermissions(this.facts, access.adminUserId, actor.userId);
    if (
      Object.keys(sample).length !== M7_OPERATIONAL_HEALTH_NUMERIC_FIELDS.length + 1 ||
      typeof sample.sampledAt !== 'string' ||
      !sample.sampledAt.endsWith('Z') ||
      !Number.isFinite(Date.parse(sample.sampledAt)) ||
      !M7_OPERATIONAL_HEALTH_NUMERIC_FIELDS.every(
        (key) => Number.isSafeInteger(sample[key]) && sample[key] >= 0,
      )
    )
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    return {
      sampledAt: sample.sampledAt,
      ...Object.fromEntries(M7_OPERATIONAL_HEALTH_NUMERIC_FIELDS.map((key) => [key, sample[key]])),
    } as M7OperationalHealth;
  }
}
