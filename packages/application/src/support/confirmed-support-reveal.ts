import type { RevealSupportThreadCommand, RevealedSupportThread } from '@nakh/contracts';
import type { Actor } from '@nakh/domain';
import type {
  ConfirmableDraft,
  ConfirmedAdminCommandBoundary,
} from '../administration/confirmed-command.js';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
} from '../administration/admin-command.js';

export interface SupportThreadRevealStore {
  reveal(attempt: AdminCommandAttempt): Promise<AdminCommandExecutionResult<RevealedSupportThread>>;
}
export class ConfirmedSupportReveals {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly store: SupportThreadRevealStore,
  ) {}
  public prepare(
    command: ConfirmableDraft<RevealSupportThreadCommand>,
    actor: Actor,
  ): Promise<string> {
    return this.boundary.prepare(command, actor, {
      permission: 'review_support',
      targetType: 'support_thread',
      payload: [],
    });
  }
  public async execute(
    command: RevealSupportThreadCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<RevealedSupportThread>> {
    const { attempt } = await this.boundary.resolve(command, actor, {
      permission: 'review_support',
      targetType: 'support_thread',
      payload: [],
    });
    return this.store.reveal(attempt);
  }
}
