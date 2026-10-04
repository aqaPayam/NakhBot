import { randomUUID } from 'node:crypto';
import {
  ConfirmedSupportReveals,
  type AdminCommandAttempt,
  type AdminCommandExecutionResult,
  type OpaqueTokenStore,
  type SupportThreadRevealStore,
} from '@nakh/application';
import type { RevealedSupportThread } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresAdminCommandStore } from './admin-command-store.js';
import { postgresConfirmationBoundary } from './confirmed-support-store.js';

/** Trusted confirmed-read capability. Required access audit failure aborts the entire attempt. */
export class PostgresSupportThreadRevealStore implements SupportThreadRevealStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async reveal(
    attempt: AdminCommandAttempt,
  ): Promise<AdminCommandExecutionResult<RevealedSupportThread>> {
    let itemCount = 0;
    return new PostgresAdminCommandStore(this.database).execute<RevealedSupportThread>(
      { ...attempt, metadata: {} },
      async (transaction) => {
        if (
          attempt.commandCode !== 'support.reveal-thread' ||
          attempt.requiredPermission !== 'review_support' ||
          attempt.targetType !== 'support_thread'
        )
          throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
        const thread = await transaction
          .selectFrom('support.support_threads')
          .select(['version', 'status'])
          .where('id', '=', attempt.targetId)
          .forShare()
          .executeTakeFirst();
        if (thread === undefined)
          throw new ApplicationError('not_found', 'error.m7.unavailable', 404);
        if (thread.version !== attempt.expectedTargetVersion)
          throw new ApplicationError('version_conflict', 'error.m7.stale_action', 409);
        const rows = await transaction
          .selectFrom('support.support_messages')
          .select(['sender_type', 'message_text', 'created_at'])
          .where('support_thread_id', '=', attempt.targetId)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(51)
          .execute();
        itemCount = Math.min(rows.length, 50);
        return {
          safeCode: 'support_revealed',
          value: {
            threadVersion: thread.version,
            status: thread.status,
            messages: rows
              .slice(0, 50)
              .reverse()
              .map((row) => ({
                senderType: row.sender_type,
                text: row.message_text,
                createdAt: row.created_at.toISOString(),
              })),
            hasEarlierMessages: rows.length > 50,
          },
        };
      },
      async (transaction, outcome) => {
        const thread = await transaction
          .selectFrom('support.support_threads')
          .select('id')
          .where('id', '=', attempt.targetId)
          .executeTakeFirst();
        // Unknown subjects still have a command log, but cannot have an FK-valid content access.
        if (
          thread === undefined ||
          attempt.commandCode !== 'support.reveal-thread' ||
          attempt.requiredPermission !== 'review_support' ||
          attempt.targetType !== 'support_thread'
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
            support_thread_id: thread.id,
            user_appeal_id: null,
            permission_code: 'review_support',
            outcome: outcome.result === 'succeeded' ? 'revealed' : 'rejected',
            safe_code: outcome.safeCode,
            item_count: outcome.result === 'succeeded' ? itemCount : 0,
          })
          .execute();
      },
    );
  }
}
export class PostgresConfirmedSupportReveals extends ConfirmedSupportReveals {
  public constructor(database: NakhDatabase, tokens: OpaqueTokenStore, key: Uint8Array) {
    super(
      postgresConfirmationBoundary(database, tokens, key),
      new PostgresSupportThreadRevealStore(database),
    );
  }
}
