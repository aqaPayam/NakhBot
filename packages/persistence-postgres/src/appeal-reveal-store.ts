import { randomUUID } from 'node:crypto';
import {
  ConfirmedAppealReveals,
  type AdminCommandAttempt,
  type AdminCommandExecutionResult,
  type AppealRevealStore,
  type OpaqueTokenStore,
} from '@nakh/application';
import type { RevealedAppeal } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { postgresConfirmationBoundary } from './confirmed-support-store.js';
/** Retained content is independent from current-ban mutation eligibility. */
export class PostgresAppealRevealStore implements AppealRevealStore {
  public constructor(private readonly database: NakhDatabase) {}
  public reveal(
    attempt: AdminCommandAttempt,
  ): Promise<AdminCommandExecutionResult<RevealedAppeal>> {
    return new PostgresAdminCommandStore(this.database).execute<RevealedAppeal>(
      { ...attempt, metadata: {} },
      async (transaction) => {
        if (
          attempt.commandCode !== 'moderation.reveal-appeal' ||
          attempt.requiredPermission !== 'review_appeals' ||
          attempt.targetType !== 'user_appeal'
        )
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        const appeal = await transaction
          .selectFrom('moderation.user_appeals')
          .select(['version', 'status', 'message_text', 'admin_note'])
          .where('id', '=', attempt.targetId)
          .forShare()
          .executeTakeFirst();
        if (appeal === undefined)
          throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
        if (appeal.version !== attempt.expectedTargetVersion)
          throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
        return {
          safeCode: 'appeal_revealed',
          value: {
            appealVersion: appeal.version,
            status: appeal.status,
            text: appeal.message_text,
            ...(appeal.admin_note === null ? {} : { note: appeal.admin_note }),
          },
        };
      },
      async (transaction, outcome) => {
        const appeal = await transaction
          .selectFrom('moderation.user_appeals')
          .select('id')
          .where('id', '=', attempt.targetId)
          .executeTakeFirst();
        if (
          appeal === undefined ||
          attempt.commandCode !== 'moderation.reveal-appeal' ||
          attempt.requiredPermission !== 'review_appeals' ||
          attempt.targetType !== 'user_appeal'
        )
          return;
        await transaction
          .insertInto('administration.safety_access_audits')
          .values({
            id: randomUUID(),
            admin_user_id: attempt.adminUserId,
            admin_action_log_id: outcome.logId,
            command_id: attempt.commandId,
            request_id: attempt.requestId,
            support_thread_id: null,
            user_appeal_id: appeal.id,
            permission_code: 'review_appeals',
            outcome: outcome.result === 'succeeded' ? 'revealed' : 'rejected',
            safe_code: outcome.safeCode,
            item_count: outcome.result === 'succeeded' ? 1 : 0,
          })
          .execute();
      },
    );
  }
}
export class PostgresConfirmedAppealReveals extends ConfirmedAppealReveals {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      postgresConfirmationBoundary(database, tokens, key),
      new PostgresAppealRevealStore(database),
    );
  }
}
