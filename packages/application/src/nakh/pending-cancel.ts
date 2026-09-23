import type { CancelPendingNakhCommand, PendingNakhResult } from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';

export type CancelPendingNakhWrite = Readonly<{
  command: CancelPendingNakhCommand;
  interactionId: string;
  matchId: string;
  chatSessionId: string;
  interactionEventId: string;
  likeClosedEventId: string;
  matchEventId: string;
  pendingEventId: string;
  auditId: string;
}>;

export interface PendingNakhCancelStore {
  cancelPending(write: CancelPendingNakhWrite): Promise<PendingNakhResult>;
}

export class CancelPendingNakhHandler {
  public constructor(
    private readonly store: PendingNakhCancelStore,
    private readonly ids: IdGenerator,
  ) {}

  public execute(command: CancelPendingNakhCommand): Promise<PendingNakhResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.store.cancelPending({
      command,
      interactionId: this.ids.uuid(),
      matchId: this.ids.uuid(),
      chatSessionId: this.ids.uuid(),
      interactionEventId: this.ids.uuid(),
      likeClosedEventId: this.ids.uuid(),
      matchEventId: this.ids.uuid(),
      pendingEventId: this.ids.uuid(),
      auditId: this.ids.uuid(),
    });
  }
}
