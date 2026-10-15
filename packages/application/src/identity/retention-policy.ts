import { createHash } from 'node:crypto';
import { ApplicationError, type IdGenerator } from '@nakh/domain';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';

/** Explicit human-approved period, measured from the original deletion's completion.
 * Recording a policy never authorizes physical release or changes its manifest. */
export type RetentionPolicyApproval = Readonly<{
  resource: string;
  retentionSeconds: number;
  basis: 'deletion_completed_at';
  evidenceHash: string;
  expectedPolicyVersion: number;
}>;
export type RetentionPolicyChange =
  | Readonly<{ action: 'approve'; policy: RetentionPolicyApproval }>
  | Readonly<{ action: 'revoke'; approvalId: string }>;
export type RetentionPolicyReceipt = Readonly<{ auditId: string; policyVersion: number }>;
export interface RetentionPolicyStore<TContext> {
  record(
    context: TContext,
    attempt: AdminCommandAttempt,
    change: RetentionPolicyChange,
    auditId: string,
  ): Promise<RetentionPolicyReceipt>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function invalid(): never {
  throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
}
function normalized(change: RetentionPolicyChange): RetentionPolicyChange {
  if (change.action === 'revoke') {
    if (!UUID.test(change.approvalId)) invalid();
    return Object.freeze({ action: 'revoke', approvalId: change.approvalId });
  }
  if (change.action !== 'approve') invalid();
  const p = change.policy;
  if (
    !/^[a-z_]+\.[a-z_]+$/u.test(p.resource) ||
    p.resource.length > 128 ||
    !Number.isSafeInteger(p.retentionSeconds) ||
    p.retentionSeconds < 1 ||
    p.retentionSeconds > 3155760000 ||
    p.basis !== 'deletion_completed_at' ||
    !/^[0-9a-f]{64}$/u.test(p.evidenceHash) ||
    !Number.isSafeInteger(p.expectedPolicyVersion) ||
    p.expectedPolicyVersion < 0 ||
    p.expectedPolicyVersion >= 2147483647
  )
    invalid();
  return Object.freeze({
    action: 'approve',
    policy: Object.freeze({
      resource: p.resource,
      retentionSeconds: p.retentionSeconds,
      basis: p.basis,
      evidenceHash: p.evidenceHash,
      expectedPolicyVersion: p.expectedPolicyVersion,
    }),
  });
}
/** Fixed ASCII tuple is also recomputed by PostgreSQL; no supplied SQL or prose. */
export function retentionPolicyRequestDigest(
  rootId: string,
  rootVersion: number,
  input: RetentionPolicyChange,
): string {
  if (!UUID.test(rootId) || !Number.isSafeInteger(rootVersion) || rootVersion < 0) invalid();
  const change = normalized(input);
  const values =
    change.action === 'approve'
      ? [
          change.policy.resource,
          change.policy.retentionSeconds,
          change.policy.basis,
          change.policy.evidenceHash,
          change.policy.expectedPolicyVersion,
        ]
      : [change.approvalId];
  return createHash('sha256')
    .update(
      JSON.stringify(['m8-retention-policy-v1', rootId, rootVersion, change.action, ...values]),
    )
    .digest('hex');
}
export class RetentionPolicyWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly policies: RetentionPolicyStore<TContext>,
    private readonly ids: IdGenerator,
  ) {}
  public record(
    attempt: AdminCommandAttempt,
    input: RetentionPolicyChange,
  ): Promise<AdminCommandExecutionResult<RetentionPolicyReceipt>> {
    const change = normalized(input);
    if (
      attempt.commandCode !== `retention.${change.action}-policy` ||
      attempt.requiredPermission !== 'approve_retention_policy' ||
      attempt.targetType !== 'account_deletion' ||
      attempt.expectedTargetVersion === null ||
      attempt.requestDigest !==
        retentionPolicyRequestDigest(attempt.targetId, attempt.expectedTargetVersion, change)
    )
      invalid();
    const bound = Object.freeze({ ...attempt, metadata: Object.freeze({}) });
    return this.commands.execute(bound, async (context) => ({
      value: await this.policies.record(context, bound, change, this.ids.uuid()),
      safeCode:
        change.action === 'approve' ? 'retention_policy_approved' : 'retention_policy_revoked',
    }));
  }
}
