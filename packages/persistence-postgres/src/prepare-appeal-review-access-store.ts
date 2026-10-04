import {
  AdminActionAuthorizationService,
  PrepareAppealReviewAccessHandler,
  type AppealActionPreparationStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';
import { currentBan } from './appeal-store.js';
export class PostgresAppealActionPreparationStore implements AppealActionPreparationStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async get(appealId: string): ReturnType<AppealActionPreparationStore['get']> {
    const row = await this.database
      .selectFrom('moderation.user_appeals as appeal')
      .innerJoin('identity.accounts as account', 'account.user_id', 'appeal.user_id')
      .select([
        'appeal.version as appealVersion',
        'appeal.status',
        'appeal.user_id',
        'appeal.ban_state_history_id',
        'account.version as accountVersion',
      ])
      .where('appeal.id', '=', appealId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      appealVersion: row.appealVersion,
      status: row.status,
      accountVersion: row.accountVersion,
      currentBan: row.ban_state_history_id === (await currentBan(this.database, row.user_id)),
    };
  }
}
export class PostgresPrepareAppealReviewAccessHandler extends PrepareAppealReviewAccessHandler {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      new AdminActionAuthorizationService(
        new PostgresAdminAuthorizationStore(database),
        tokens,
        key,
      ),
      new PostgresAdminQueueIdentityStore(database),
      new PostgresAppealActionPreparationStore(database),
    );
  }
}
