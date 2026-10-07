import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';

/** Caller holds the owning admin row lock. Enrollment and login share one durable attempt budget. */
export async function consumeAdminTotpAttempt(
  database: NakhDatabase,
  adminId: string,
  at: Date,
): Promise<boolean> {
  const admitted = (
    await sql`INSERT INTO administration.admin_totp_attempt_windows(admin_user_id,started_at,attempts)
    VALUES(${adminId}::uuid,${at}::timestamptz,1)
    ON CONFLICT(admin_user_id) DO UPDATE SET
      started_at=CASE WHEN admin_totp_attempt_windows.started_at<=${at}::timestamptz-interval '5 minutes'
        THEN ${at}::timestamptz ELSE admin_totp_attempt_windows.started_at END,
      attempts=CASE WHEN admin_totp_attempt_windows.started_at<=${at}::timestamptz-interval '5 minutes'
        THEN 1 ELSE admin_totp_attempt_windows.attempts+1 END
    WHERE admin_totp_attempt_windows.started_at<=${at}::timestamptz-interval '5 minutes'
      OR admin_totp_attempt_windows.attempts<5 RETURNING attempts`.execute(database)
  ).rows[0];
  return admitted !== undefined;
}

export async function adminTotpDatabaseTime(database: NakhDatabase): Promise<Date> {
  return (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(database)).rows[0]!.at;
}

/** First-factor identity/RBAC only: setup and login cannot require an already issued MFA session. */
export async function hasAdminTotpIdentityAndRoles(
  database: NakhDatabase,
  adminId: string,
): Promise<boolean> {
  const current = (
    await sql`SELECT admin.id FROM administration.admin_users admin
    JOIN identity.telegram_identities identity ON identity.user_id=admin.user_id AND identity.telegram_user_id=admin.telegram_user_id
    WHERE admin.id=${adminId}::uuid AND admin.is_active AND admin.identity_verified_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM administration.admin_user_roles assignment
      JOIN administration.admin_roles role ON role.code=assignment.role_code AND role.is_active
      JOIN administration.admin_role_permissions permission ON permission.role_code=role.code
      WHERE assignment.admin_user_id=admin.id AND assignment.revoked_at IS NULL)`.execute(database)
  ).rows[0];
  return current !== undefined;
}
