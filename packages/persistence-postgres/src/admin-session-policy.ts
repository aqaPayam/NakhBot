import { sql } from 'kysely';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

const required = new WeakSet<NakhDatabase>();
const totpRequired = new WeakSet<NakhDatabase>();
/** Trusted host configuration, monotonic for this database owner. No transport input can relax it. */
export function requireNativeAdminSessions(database: NakhDatabase): void {
  required.add(database);
}
export function nativeAdminSessionsRequired(database: NakhDatabase): boolean {
  return required.has(database);
}
/** Opting into native TOTP cannot be relaxed by a later generic session composition. */
export function requireNativeAdminTotp(database: NakhDatabase): void {
  requireNativeAdminSessions(database);
  totpRequired.add(database);
}
export function nativeAdminTotpRequired(database: NakhDatabase): boolean {
  return totpRequired.has(database);
}
export function inheritNativeAdminSessionPolicy(
  owner: NakhDatabase,
  transaction: NakhDatabase,
): void {
  if (required.has(owner)) required.add(transaction);
  if (totpRequired.has(owner)) totpRequired.add(transaction);
}
/** Fresh database clock, not transaction start time. The optional ID pins an admitted grant. */
export async function currentNativeAdminSession(
  database: NakhDatabase,
  adminUserId: string,
  sessionId?: string,
): Promise<string | undefined> {
  const row = (
    await sql<{ id: string }>`SELECT session.id FROM administration.admin_sessions session
    JOIN administration.admin_users admin ON admin.id=session.admin_user_id
    JOIN identity.telegram_identities identity ON identity.user_id=admin.user_id AND identity.telegram_user_id=admin.telegram_user_id
    LEFT JOIN administration.admin_totp_credentials credential ON credential.id=session.totp_credential_id
    WHERE session.admin_user_id=${adminUserId}::uuid AND session.revoked_at IS NULL
      AND admin.is_active AND admin.identity_verified_at IS NOT NULL AND session.admin_version=admin.version
      AND session.expires_at>clock_timestamp() AND session.mfa_expires_at>clock_timestamp()
      AND (session.totp_credential_id IS NULL OR (credential.id IS NOT NULL AND credential.revoked_at IS NULL))
      AND ${nativeAdminTotpRequired(database) ? sql`session.totp_credential_id IS NOT NULL` : sql`true`}
      AND ${sessionId === undefined ? sql`true` : sql`session.id=${sessionId}::uuid`}
      AND EXISTS(SELECT 1 FROM administration.admin_user_roles assignment
        JOIN administration.admin_roles role ON role.code=assignment.role_code AND role.is_active
        JOIN administration.admin_role_permissions permission ON permission.role_code=role.code
        WHERE assignment.admin_user_id=admin.id AND assignment.revoked_at IS NULL)
    LIMIT 1`.execute(database)
  ).rows[0];
  return row?.id;
}
export async function assertNativeAdminSession(
  database: NakhDatabase,
  adminUserId: string,
  sessionId?: string,
): Promise<string> {
  const current = await currentNativeAdminSession(database, adminUserId, sessionId);
  if (current === undefined) throw new ApplicationError('forbidden', 'error.m7.unavailable', 403);
  return current;
}
