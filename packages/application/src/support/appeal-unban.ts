import { createHash } from 'node:crypto';

import { ApplicationError, type IdGenerator } from '@nakh/domain';

import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  AdminCommandExecutionStore,
} from '../administration/admin-command.js';
import type {
  AccountModerationResult,
  AccountModerationWrite,
} from '../moderation/account-action.js';

export type AppealUnbanWrite = Readonly<{
  appealId: string;
  expectedAppealVersion: number;
  adminLogId: string;
  accountAction: Omit<AccountModerationWrite, 'action' | 'targetUserId'>;
}>;
export interface AppealUnbanStore<TContext> {
  unban(context: TContext, write: AppealUnbanWrite): Promise<AccountModerationResult>;
}

/** Separate confirmed command; review_appeals can never substitute for unban_user. */
export class AppealUnbanWorkflow<TContext> {
  public constructor(
    private readonly commands: AdminCommandExecutionStore<TContext>,
    private readonly store: AppealUnbanStore<TContext>,
    private readonly ids: IdGenerator,
  ) {}

  public unban(
    attempt: AdminCommandAttempt,
    expectedAccountVersion: number,
  ): Promise<AdminCommandExecutionResult<AccountModerationResult>> {
    if (
      attempt.commandCode !== 'moderation.unban-appeal' ||
      attempt.requiredPermission !== 'unban_user' ||
      attempt.targetType !== 'user_appeal' ||
      attempt.expectedTargetVersion === null
    )
      throw new ApplicationError('invalid_request', 'error.appeal.unban_invalid', 400);
    const boundAttempt = {
      ...attempt,
      metadata: {},
      requestDigest: createHash('sha256')
        .update(JSON.stringify([attempt.requestDigest, expectedAccountVersion]))
        .digest('hex'),
    };
    return this.commands.execute(boundAttempt, async (context) => {
      if (!Number.isSafeInteger(expectedAccountVersion) || expectedAccountVersion < 1)
        throw new ApplicationError('invalid_request', 'error.appeal.unban_invalid', 400);
      return {
        value: await this.store.unban(context, {
          appealId: attempt.targetId,
          expectedAppealVersion: attempt.expectedTargetVersion!,
          adminLogId: attempt.logId,
          accountAction: {
            adminUserId: attempt.adminUserId,
            expectedAccountVersion,
            requestId: attempt.requestId,
            commandId: attempt.commandId,
            requestDigest: boundAttempt.requestDigest,
            actionId: this.ids.uuid(),
            auditId: this.ids.uuid(),
            accountHistoryId: this.ids.uuid(),
            notificationId: this.ids.uuid(),
            notificationDeliveryId: this.ids.uuid(),
            notificationDeliveryEventId: this.ids.uuid(),
            accountEventId: this.ids.uuid(),
            actionEventId: this.ids.uuid(),
          },
        }),
        safeCode: 'appeal_unbanned',
      };
    });
  }
}
