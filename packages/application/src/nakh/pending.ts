import type { CreatePendingNakhCommand, PendingNakhResult } from '@nakh/contracts';
import { ApplicationError, type IdGenerator, validateNakhText } from '@nakh/domain';

export type CreatePendingNakhWrite = Readonly<{
  command: CreatePendingNakhCommand;
  flowId: string;
  pendingNakhId: string;
  pendingPaymentId: string;
  flowEventId: string;
  pendingEventId: string;
}>;

export interface PendingNakhStore {
  createPending(write: CreatePendingNakhWrite): Promise<PendingNakhResult>;
}

export class CreatePendingNakhHandler {
  public constructor(
    private readonly store: PendingNakhStore,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: CreatePendingNakhCommand): Promise<PendingNakhResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    validateNakhText(command.data.text);
    return this.store.createPending({
      command,
      flowId: this.ids.uuid(),
      pendingNakhId: this.ids.uuid(),
      pendingPaymentId: this.ids.uuid(),
      flowEventId: this.ids.uuid(),
      pendingEventId: this.ids.uuid(),
    });
  }
}
