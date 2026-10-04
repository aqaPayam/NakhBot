import type { RevealAppealCommand, RevealedAppeal } from '@nakh/contracts';
import type { Actor } from '@nakh/domain';
import type {
  ConfirmableDraft,
  ConfirmedAdminCommandBoundary,
} from '../administration/confirmed-command.js';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
} from '../administration/admin-command.js';
export interface AppealRevealStore {
  reveal(attempt: AdminCommandAttempt): Promise<AdminCommandExecutionResult<RevealedAppeal>>;
}
export class ConfirmedAppealReveals {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly store: AppealRevealStore,
  ) {}
  public prepare(command: ConfirmableDraft<RevealAppealCommand>, actor: Actor): Promise<string> {
    return this.boundary.prepare(command, actor, {
      permission: 'review_appeals',
      targetType: 'user_appeal',
      payload: [],
    });
  }
  public async execute(
    command: RevealAppealCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<RevealedAppeal>> {
    const { attempt } = await this.boundary.resolve(command, actor, {
      permission: 'review_appeals',
      targetType: 'user_appeal',
      payload: [],
    });
    return this.store.reveal(attempt);
  }
}
