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
