import { sql } from 'kysely';
import type { AdminCommandAttempt } from '@nakh/application';
import type { NakhDatabase } from '../database.js';
import { PostgresAdminCommandStore } from '../admin-command-store.js';

/** Frozen permission query from accepted 2140bbd, for genuine populated
 * schema 122..161 upgrade fixtures only. No temporary function is installed in
 * those historical schemas. Never exported or selected by live composition.
 * The parent retains native identity/session, transaction, audit and replay rules. */
export class PreRuntimeAdminCommandStore extends PostgresAdminCommandStore {
  protected override async lockPermission(
    transaction: NakhDatabase,
    attempt: AdminCommandAttempt,
  ): Promise<{ permission_code: string } | undefined> {
    const version = (
      await sql<{ version: number }>`SELECT coalesce(max(left(name,6)::integer),0) AS version
      FROM platform.schema_migrations`.execute(transaction)
    ).rows[0]!.version;
    if (version < 122 || version >= 162)
      throw new Error('Historical administrator fixture schema unavailable.');
    return transaction
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
      .forShare()
      .executeTakeFirst();
  }
}
