import { sql } from 'kysely';

import {
  adminRejectionSafeCode,
  isAdminSafeCode,
  validateAdminCommandAttempt,
  validateEvidenceAccessAttempt,
  type AdminActionResult,
  type AdminCommandAttempt,
  type AdminCommandEffectResult,
  type AdminCommandExecutionResult,
  type AdminCommandExecutionStore,
  type EvidenceAccessAttempt,
  type EvidenceAccessResult,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

type RecordedAdminAction = Readonly<{
  id: string;
  request_digest: string;
  command_code: string;
  target_type: string;
  target_id: string;
  expected_target_version: number | null;
  reason_digest: string;
  result: AdminActionResult;
  safe_code: string;
  created_at: Date;
}>;

function idempotencyConflict(): ApplicationError {
  return new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
}

function isIdenticalCommand(row: RecordedAdminAction, attempt: AdminCommandAttempt): boolean {
  return (
    row.request_digest === attempt.requestDigest &&
    row.command_code === attempt.commandCode &&
    row.target_type === attempt.targetType &&
    row.target_id === attempt.targetId &&
    row.expected_target_version === attempt.expectedTargetVersion &&
    row.reason_digest === attempt.reasonDigest
  );
}

/**
 * Provides the M7 command transaction boundary. The business callback runs inside a savepoint, so a
 * domain rejection can be rolled back while its sanitized attempt record still commits. Transport
 * and database failures remain outside that classification and abort the whole outer transaction.
 */
export class PostgresAdminCommandStore implements AdminCommandExecutionStore<NakhDatabase> {
  public constructor(private readonly database: NakhDatabase) {}

  public async execute<T>(
    attempt: AdminCommandAttempt,
    effect: (transaction: NakhDatabase) => Promise<AdminCommandEffectResult<T>>,
  ): Promise<AdminCommandExecutionResult<T>> {
    validateAdminCommandAttempt(attempt);
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${'admin-command:'} || ${attempt.adminUserId}::text || ':' || ${attempt.commandId}::text, 0)
      )`.execute(transaction);

      const existing = await transaction
        .selectFrom('administration.admin_action_logs')
        .select([
          'id',
          'request_digest',
          'command_code',
          'target_type',
          'target_id',
          'expected_target_version',
          'reason_digest',
          'result',
          'safe_code',
          'created_at',
        ])
        .where('admin_user_id', '=', attempt.adminUserId)
        .where('command_id', '=', attempt.commandId)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (!isIdenticalCommand(existing, attempt)) throw idempotencyConflict();
        return {
          logId: existing.id,
          result: existing.result,
          safeCode: existing.safe_code,
          recordedAt: existing.created_at,
          replayed: true,
          value: undefined,
        };
      }

      let result: AdminActionResult;
      let safeCode: string;
      let value: T | undefined;
      const admin = await transaction
        .selectFrom('administration.admin_users')
        .select('is_active')
        .where('id', '=', attempt.adminUserId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const permission = admin.is_active
        ? await transaction
            .selectFrom('administration.admin_user_roles as assignment')
            .innerJoin('administration.admin_roles as role', 'role.code', 'assignment.role_code')
            .innerJoin(
              'administration.admin_role_permissions as role_permission',
              'role_permission.role_code',
              'role.code',
            )
            .select('role_permission.permission_code')
            .where('assignment.admin_user_id', '=', attempt.adminUserId)
            .where('assignment.revoked_at', 'is', null)
            .where('role.is_active', '=', true)
            .where('role_permission.permission_code', '=', attempt.requiredPermission)
            .executeTakeFirst()
        : undefined;
      if (!admin.is_active || permission === undefined) {
        result = 'rejected';
        safeCode = 'forbidden';
        value = undefined;
      } else {
        await sql`SAVEPOINT admin_command_effect`.execute(transaction);
        try {
          const effectResult = await effect(transaction);
          if (!isAdminSafeCode(effectResult.safeCode))
            throw new Error('Admin effect safe code is invalid.');
          result = 'succeeded';
          safeCode = effectResult.safeCode;
          value = effectResult.value;
          await sql`RELEASE SAVEPOINT admin_command_effect`.execute(transaction);
        } catch (error) {
          await sql`ROLLBACK TO SAVEPOINT admin_command_effect`.execute(transaction);
          await sql`RELEASE SAVEPOINT admin_command_effect`.execute(transaction);
          value = undefined;
          if (error instanceof ApplicationError) {
            result = 'rejected';
            safeCode = adminRejectionSafeCode(error.code);
          } else {
            result = 'failed';
            safeCode = 'internal_error';
          }
        }
      }

      const recorded = await transaction
        .insertInto('administration.admin_action_logs')
        .values({
          id: attempt.logId,
          admin_user_id: attempt.adminUserId,
          command_id: attempt.commandId,
          request_id: attempt.requestId,
          request_digest: attempt.requestDigest,
          command_code: attempt.commandCode,
          target_type: attempt.targetType,
          target_id: attempt.targetId,
          expected_target_version: attempt.expectedTargetVersion,
          result,
          safe_code: safeCode,
          reason_digest: attempt.reasonDigest,
          metadata: attempt.metadata,
          correlation_id: attempt.correlationId,
        })
        .returning('created_at')
        .executeTakeFirstOrThrow();
      return {
        logId: attempt.logId,
        result,
        safeCode,
        recordedAt: recorded.created_at,
        replayed: false,
        value,
      };
    });
  }

  public async recordEvidenceAccess(attempt: EvidenceAccessAttempt): Promise<EvidenceAccessResult> {
    validateEvidenceAccessAttempt(attempt);
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${'evidence-access:'} || ${attempt.commandId}::text, 0)
      )`.execute(transaction);
      const existing = await transaction
        .selectFrom('moderation.evidence_access_audits')
        .selectAll()
        .where('command_id', '=', attempt.commandId)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (
          existing.report_id !== attempt.reportId ||
          existing.report_evidence_id !== attempt.reportEvidenceId ||
          existing.admin_user_id !== attempt.adminUserId ||
          existing.reason_code !== attempt.reasonCode ||
          existing.permission_code !== attempt.permissionCode ||
          existing.outcome !== attempt.outcome ||
          existing.safe_code !== attempt.safeCode
        )
          throw idempotencyConflict();
        return {
          auditId: existing.id,
          outcome: existing.outcome,
          safeCode: existing.safe_code,
          accessedAt: existing.accessed_at,
          replayed: true,
        };
      }

      const recorded = await transaction
        .insertInto('moderation.evidence_access_audits')
        .values({
          id: attempt.auditId,
          report_id: attempt.reportId,
          report_evidence_id: attempt.reportEvidenceId,
          admin_user_id: attempt.adminUserId,
          reason_code: attempt.reasonCode,
          request_id: attempt.requestId,
          command_id: attempt.commandId,
          permission_code: attempt.permissionCode,
          outcome: attempt.outcome,
          safe_code: attempt.safeCode,
        })
        .returning('accessed_at')
        .executeTakeFirstOrThrow();
      return {
        auditId: attempt.auditId,
        outcome: attempt.outcome,
        safeCode: attempt.safeCode,
        accessedAt: recorded.accessed_at,
        replayed: false,
      };
    });
  }
}
