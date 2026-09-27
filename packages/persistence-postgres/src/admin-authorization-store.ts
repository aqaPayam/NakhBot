import type { AdminAuthorizationFacts, AdminAuthorizationStore } from '@nakh/application';
import type { M7Permission } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

type AdminIdentityRow = Readonly<{
  admin_user_id: string;
  actor_user_id: string;
  is_active: boolean;
}>;

export class PostgresAdminAuthorizationStore implements AdminAuthorizationStore {
  public constructor(private readonly database: NakhDatabase) {}

  private async permissions(adminUserId: string): Promise<readonly M7Permission[]> {
    const rows = await this.database
      .selectFrom('administration.admin_user_roles as assignment')
      .innerJoin('administration.admin_roles as role', 'role.code', 'assignment.role_code')
      .innerJoin(
        'administration.admin_role_permissions as role_permission',
        'role_permission.role_code',
        'role.code',
      )
      .innerJoin(
        'administration.admin_permissions as permission',
        'permission.code',
        'role_permission.permission_code',
      )
      .select('permission.code')
      .where('assignment.admin_user_id', '=', adminUserId)
      .where('assignment.revoked_at', 'is', null)
      .where('role.is_active', '=', true)
      .distinct()
      .orderBy('permission.code')
      .execute();
    return rows.map((row) => row.code as M7Permission);
  }

  private async facts(
    row: AdminIdentityRow | undefined,
  ): Promise<AdminAuthorizationFacts | undefined> {
    if (row === undefined) return undefined;
    return {
      adminUserId: row.admin_user_id,
      actorUserId: row.actor_user_id,
      adminActive: row.is_active,
      activePermissions: await this.permissions(row.admin_user_id),
    };
  }

  public async loadByTelegramIdentity(
    input: Readonly<{
      actorUserId: string;
      telegramUserId: string;
    }>,
  ): Promise<AdminAuthorizationFacts | undefined> {
    const row = await this.database
      .selectFrom('administration.admin_users as admin')
      .innerJoin('identity.telegram_identities as identity', (join) =>
        join
          .onRef('identity.user_id', '=', 'admin.user_id')
          .onRef('identity.telegram_user_id', '=', 'admin.telegram_user_id'),
      )
      .select(['admin.id as admin_user_id', 'admin.user_id as actor_user_id', 'admin.is_active'])
      .where('admin.user_id', '=', input.actorUserId)
      .where('admin.telegram_user_id', '=', input.telegramUserId)
      .where('admin.identity_verified_at', 'is not', null)
      .executeTakeFirst();
    return this.facts(row);
  }

  public async loadCurrent(
    input: Readonly<{
      adminUserId: string;
      actorUserId: string;
    }>,
  ): Promise<AdminAuthorizationFacts | undefined> {
    const row = await this.database
      .selectFrom('administration.admin_users as admin')
      .innerJoin('identity.telegram_identities as identity', (join) =>
        join
          .onRef('identity.user_id', '=', 'admin.user_id')
          .onRef('identity.telegram_user_id', '=', 'admin.telegram_user_id'),
      )
      .select(['admin.id as admin_user_id', 'admin.user_id as actor_user_id', 'admin.is_active'])
      .where('admin.id', '=', input.adminUserId)
      .where('admin.user_id', '=', input.actorUserId)
      .where('admin.identity_verified_at', 'is not', null)
      .executeTakeFirst();
    return this.facts(row);
  }
}
