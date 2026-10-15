import { sql } from 'kysely';
import {
  RetentionPolicyWorkflow,
  type RetentionPolicyStore,
  type RetentionPolicyChange,
  type RetentionPolicyReceipt,
  type AdminCommandAttempt,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { assertNativeAdminSession, requireNativeAdminSessions } from './admin-session-policy.js';
import { SystemIdGenerator } from './foundation-store.js';

export class PostgresRetentionPolicyStore implements RetentionPolicyStore<NakhDatabase> {
  public async record(
    db: NakhDatabase,
    attempt: AdminCommandAttempt,
    change: RetentionPolicyChange,
    auditId: string,
  ): Promise<RetentionPolicyReceipt> {
    const sessionId = await assertNativeAdminSession(db, attempt.adminUserId);
    const payload = change.action === 'approve' ? change.policy : { approvalId: change.approvalId };
    const result = (
      await sql<{
        policy_version: number;
        rejection: string | null;
      }>`SELECT * FROM identity.record_retention_policy(
      ${auditId}::uuid,${attempt.adminUserId}::uuid,${attempt.targetId}::uuid,${attempt.expectedTargetVersion}::integer,
      ${change.action},${JSON.stringify(payload)}::jsonb,${attempt.logId}::uuid,${sessionId}::uuid,${attempt.commandId}::uuid,${attempt.requestId}::uuid)
    `.execute(db)
    ).rows[0];
    if (result?.rejection === 'version_conflict')
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
    if (result === undefined || result.rejection !== null)
      throw new ApplicationError('conflict', 'error.deletion.unavailable', 409);
    return { auditId, policyVersion: result.policy_version };
  }
}
export class PostgresRetentionPolicyWorkflow extends RetentionPolicyWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase) {
    requireNativeAdminSessions(database);
    super(
      new PostgresAdminCommandStore(database),
      new PostgresRetentionPolicyStore(),
      new SystemIdGenerator(),
    );
  }
}

export type RetentionPeriodReview = Readonly<{
  deletionRecordId: string;
  retentionRecordId: string;
  resource: string;
  policyVersion: number;
  approvalId: string | null;
  status: 'pending_policy' | 'policy_revoked' | 'waiting_period' | 'period_elapsed';
  eligibleAfter: string | null;
  evaluatedAt: string;
  releaseEnabled: false;
}>;

/** Internal planning only. A due period is not an original-row ownership proof,
 * dependency disposition, release lease or permission to delete retained data. */
export class PostgresRetentionPeriodReviewStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async review(
    input: Readonly<{
      deletionRecordId: string;
      retentionRecordId: string;
      expectedRootVersion: number;
    }>,
  ): Promise<RetentionPeriodReview> {
    const { deletionRecordId, retentionRecordId, expectedRootVersion } = input;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
    if (
      !uuid.test(deletionRecordId) ||
      !uuid.test(retentionRecordId) ||
      !Number.isSafeInteger(expectedRootVersion) ||
      expectedRootVersion < 0 ||
      expectedRootVersion > 2147483647
    )
      throw new ApplicationError('invalid_request', 'error.deletion.unavailable', 400);
    const review = async (tx: NakhDatabase): Promise<RetentionPeriodReview> => {
      const unavailable = (): never => {
        throw new ApplicationError('conflict', 'error.deletion.unavailable', 409);
      };
      const root = (
        await sql<{ user_id: string }>`SELECT user_id FROM identity.account_deletion_records
        WHERE id=${deletionRecordId}::uuid`.execute(tx)
      ).rows[0];
      if (root === undefined) return unavailable();
      // Same lock order as policy approval/revocation and Return. Read policy
      // only after these locks: a lock wait cannot preserve a stale approval.
      await sql`SELECT id FROM identity.users WHERE id=${root.user_id}::uuid FOR NO KEY UPDATE`.execute(
        tx,
      );
      await sql`SELECT user_id FROM identity.accounts WHERE user_id=${root.user_id}::uuid FOR UPDATE`.execute(
        tx,
      );
      await sql`SELECT id FROM identity.account_deletion_records WHERE id=${deletionRecordId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const record = (
        await sql<{ resource: string }>`SELECT r.retained_data_type AS resource
        FROM identity.data_retention_records r JOIN identity.account_deletion_records root ON root.id=r.deletion_record_id
        WHERE root.id=${deletionRecordId}::uuid AND r.id=${retentionRecordId}::uuid
        AND root.account_version=${expectedRootVersion}
        AND identity.retention_policy_eligible(root.id,r.id)`.execute(tx)
      ).rows[0];
      if (record === undefined) return unavailable();
      const policy = (
        await sql<{
          id: string;
          version: number;
          valid: boolean;
          revoked: boolean;
          revocations_valid: boolean;
          eligible_after: Date;
          elapsed: boolean;
          evaluated_at: Date;
        }>`WITH evaluation AS MATERIALIZED (SELECT clock_timestamp() AS at), latest AS (
        SELECT a.* FROM platform.audit_logs a WHERE a.subject_id=${deletionRecordId}::uuid
        AND a.event_type='account.retention-policy-approved.v1'
        AND a.metadata->>'retentionRecordId'=${retentionRecordId}
        ORDER BY (a.metadata->>'policyVersion')::integer DESC LIMIT 1
      ) SELECT a.id,(a.metadata->>'policyVersion')::integer AS version,
        identity.retention_policy_proof_valid(a,false) AS valid,
        EXISTS(SELECT 1 FROM platform.audit_logs r WHERE r.event_type='account.retention-policy-revoked.v1'
          AND r.metadata->>'approvalId'=a.id::text) AS revoked,
        NOT EXISTS(SELECT 1 FROM platform.audit_logs r WHERE r.event_type='account.retention-policy-revoked.v1'
          AND r.metadata->>'approvalId'=a.id::text AND identity.retention_policy_proof_valid(r,false) IS NOT TRUE) AS revocations_valid,
        root.completed_at+make_interval(secs => (a.metadata->>'retentionSeconds')::double precision) AS eligible_after,
        root.completed_at+make_interval(secs => (a.metadata->>'retentionSeconds')::double precision)<=evaluation.at AS elapsed,
        evaluation.at AS evaluated_at
        FROM latest a JOIN identity.account_deletion_records root ON root.id=a.subject_id CROSS JOIN evaluation`.execute(
          tx,
        )
      ).rows[0];
      if (policy !== undefined && (policy.valid !== true || policy.revocations_valid !== true))
        unavailable();
      const evaluatedAt =
        policy?.evaluated_at ??
        (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(tx)).rows[0]!.at;
      return Object.freeze({
        deletionRecordId,
        retentionRecordId,
        resource: record.resource,
        policyVersion: policy?.version ?? 0,
        approvalId: policy?.id ?? null,
        status:
          policy === undefined
            ? 'pending_policy'
            : policy.revoked
              ? 'policy_revoked'
              : policy.elapsed
                ? 'period_elapsed'
                : 'waiting_period',
        eligibleAfter:
          policy === undefined || policy.revoked ? null : policy.eligible_after.toISOString(),
        evaluatedAt: evaluatedAt.toISOString(),
        releaseEnabled: false,
      });
    };
    return this.database.isTransaction
      ? review(this.database)
      : this.database.transaction().execute(review);
  }
}
