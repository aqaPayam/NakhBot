import { sql } from 'kysely';
import {
  AccountReturnApprovalWorkflow,
  type AccountReturnApproval,
  type AccountReturnApprovalStore,
  type AdminCommandAttempt,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { assertNativeAdminSession, requireNativeAdminSessions } from './admin-session-policy.js';
import { SystemIdGenerator } from './foundation-store.js';

function unavailable(): ApplicationError {
  return new ApplicationError('conflict', 'error.deletion.unavailable', 409);
}

export class PostgresAccountReturnApprovalStore implements AccountReturnApprovalStore<NakhDatabase> {
  public async approve(
    database: NakhDatabase,
    attempt: AdminCommandAttempt,
    auditId: string,
  ): Promise<AccountReturnApproval> {
    const root = (
      await sql<{ user_id: string; product_epoch: number; account_version: number }>`
      SELECT user_id,product_epoch,account_version FROM identity.account_deletion_records
      WHERE id=${attempt.targetId}::uuid`.execute(database)
    ).rows[0];
    if (root === undefined) throw unavailable();
    await sql`SELECT id FROM identity.users WHERE id=${root.user_id}::uuid FOR NO KEY UPDATE`.execute(
      database,
    );
    await sql`SELECT user_id FROM identity.accounts WHERE user_id=${root.user_id}::uuid FOR UPDATE`.execute(
      database,
    );
    await sql`SELECT id FROM identity.account_deletion_records WHERE id=${attempt.targetId}::uuid FOR UPDATE`.execute(
      database,
    );
    if (root.account_version !== attempt.expectedTargetVersion)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
    const sessionId = await assertNativeAdminSession(database, attempt.adminUserId);
    const available = await sql<{
      available: boolean;
    }>`SELECT identity.account_return_reviewable(${attempt.targetId}::uuid) AS available`.execute(
      database,
    );
    if (available.rows[0]?.available !== true) throw unavailable();
    const existing = await database
      .selectFrom('platform.audit_logs')
      .select('id')
      .where('event_type', '=', 'account.return-approved.v1')
      .where('subject_id', '=', attempt.targetId)
      .executeTakeFirst();
    if (existing !== undefined)
      return { approvalId: existing.id, productEpoch: root.product_epoch };
    const inserted = await sql<{ id: string }>`INSERT INTO platform.audit_logs
      (id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,
       metadata_schema_version,metadata,command_id,request_id,occurred_at)
      VALUES(${auditId}::uuid,'account','account.return-approved.v1','admin',NULL,${attempt.adminUserId}::uuid,
        'account_deletion',${attempt.targetId}::uuid,'return_approved',1,
        jsonb_build_object('productEpoch',${root.product_epoch}::integer,'accountVersion',${root.account_version}::integer,
          'adminLogId',${attempt.logId}::text,'sessionId',${sessionId}::text,'transactionId',pg_current_xact_id()::text),
        ${attempt.commandId}::uuid,${attempt.requestId}::uuid,clock_timestamp()) RETURNING id`.execute(
      database,
    );
    if (inserted.rows.length !== 1) throw new Error('Account return approval audit missing.');
    return { approvalId: auditId, productEpoch: root.product_epoch };
  }
}

export class PostgresAccountReturnApprovalWorkflow extends AccountReturnApprovalWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase) {
    requireNativeAdminSessions(database);
    super(
      new PostgresAdminCommandStore(database),
      new PostgresAccountReturnApprovalStore(),
      new SystemIdGenerator(),
    );
  }
}
