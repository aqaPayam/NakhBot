import {
  AppealUnbanWorkflow,
  type AppealUnbanStore,
  type AppealUnbanWrite,
  type AccountModerationResult,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import { PostgresAccountModerationStore } from './account-moderation-store.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { currentBan, lockAppealAccount } from './appeal-store.js';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';

function unavailable(): ApplicationError {
  return new ApplicationError('conflict', 'error.appeal.unban_unavailable', 409);
}

export class PostgresAppealUnbanStore implements AppealUnbanStore<NakhDatabase> {
  public async unban(
    database: NakhDatabase,
    write: AppealUnbanWrite,
  ): Promise<AccountModerationResult> {
    const owner = await database
      .selectFrom('moderation.user_appeals')
      .select('user_id')
      .where('id', '=', write.appealId)
      .executeTakeFirst();
    if (owner === undefined) throw unavailable();
    await lockAppealAccount(database, owner.user_id);
    const banId = await currentBan(database, owner.user_id);
    const appeal = await database
      .selectFrom('moderation.user_appeals')
      .select(['status', 'version', 'ban_state_history_id'])
      .where('id', '=', write.appealId)
      .forUpdate()
      .executeTakeFirst();
    if (
      appeal === undefined ||
      appeal.status !== 'accepted' ||
      appeal.ban_state_history_id !== banId
    )
      throw unavailable();
    if (appeal.version !== write.expectedAppealVersion)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
    // Reuses Account's owning command, including its transition, history, safety notification,
    // delivery intent, audit and moderation action in this same admin-command transaction.
    const result = await new PostgresAccountModerationStore().apply(database, {
      ...write.accountAction,
      action: 'unban_user',
      targetUserId: owner.user_id,
    });
    await database
      .insertInto('moderation.appeal_unbans')
      .values({
        appeal_id: write.appealId,
        action_id: result.actionId,
        unban_history_id: write.accountAction.accountHistoryId,
        admin_action_log_id: write.adminLogId,
      })
      .execute();
    return result;
  }
}

export class PostgresAppealUnbanWorkflow extends AppealUnbanWorkflow<NakhDatabase> {
  public constructor(database: NakhDatabase) {
    super(
      new PostgresAdminCommandStore(database),
      new PostgresAppealUnbanStore(),
      new SystemIdGenerator(),
    );
  }
}
