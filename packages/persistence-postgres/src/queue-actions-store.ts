import {
  AdminActionAuthorizationService,
  GetAdminReportQueueActionsHandler,
  type AdminQueueIdentityStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
class PostgresAdminQueueIdentityStore implements AdminQueueIdentityStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async get(actorUserId: string): ReturnType<AdminQueueIdentityStore['get']> {
    return this.database
      .selectFrom('administration.admin_users as admin')
      .innerJoin('identity.telegram_identities as identity', (join) =>
        join
          .onRef('identity.user_id', '=', 'admin.user_id')
          .onRef('identity.telegram_user_id', '=', 'admin.telegram_user_id'),
      )
      .select(['admin.id as adminUserId', 'admin.telegram_user_id as telegramUserId'])
      .where('admin.user_id', '=', actorUserId)
      .where('admin.is_active', '=', true)
      .where('admin.identity_verified_at', 'is not', null)
      .executeTakeFirst();
  }
}
export class PostgresGetAdminReportQueueActionsHandler extends GetAdminReportQueueActionsHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new PostgresAdminQueueIdentityStore(database),
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
    );
  }
}
