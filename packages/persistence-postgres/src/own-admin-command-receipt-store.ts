import {
  GetOwnAdminCommandReceiptHandler,
  type OwnAdminCommandReceiptStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
class PostgresOwnAdminCommandReceiptStore implements OwnAdminCommandReceiptStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async get(
    adminUserId: string,
    commandId: string,
  ): ReturnType<OwnAdminCommandReceiptStore['get']> {
    return this.database
      .selectFrom('administration.admin_action_logs as log')
      .innerJoin('administration.admin_users as admin', 'admin.id', 'log.admin_user_id')
      .innerJoin('identity.telegram_identities as identity', (join) =>
        join
          .onRef('identity.user_id', '=', 'admin.user_id')
          .onRef('identity.telegram_user_id', '=', 'admin.telegram_user_id'),
      )
      .select([
        'log.id as logId',
        'log.result',
        'log.safe_code as safeCode',
        'log.created_at as recordedAt',
      ])
      .where('log.admin_user_id', '=', adminUserId)
      .where('log.command_id', '=', commandId)
      .where('admin.is_active', '=', true)
      .where('admin.identity_verified_at', 'is not', null)
      .executeTakeFirst();
  }
}
export class PostgresGetOwnAdminCommandReceiptHandler extends GetOwnAdminCommandReceiptHandler {
  public constructor(database: NakhDatabase) {
    super(
      new PostgresAdminQueueIdentityStore(database),
      new PostgresOwnAdminCommandReceiptStore(database),
    );
  }
}
