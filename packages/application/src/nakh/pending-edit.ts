import type { EditPendingNakhCommand, PendingNakhResult } from '@nakh/contracts';
import { ApplicationError, type IdGenerator, validateNakhText } from '@nakh/domain';

export type EditPendingNakhWrite = Readonly<{
  command: EditPendingNakhCommand;
  pendingEventId: string;
}>;

export interface PendingNakhEditStore {
  editPending(write: EditPendingNakhWrite): Promise<PendingNakhResult>;
}

export class EditPendingNakhHandler {
  public constructor(
    private readonly store: PendingNakhEditStore,
    private readonly ids: IdGenerator,
  ) {}

  public execute(command: EditPendingNakhCommand): Promise<PendingNakhResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    validateNakhText(command.data.text);
    return this.store.editPending({ command, pendingEventId: this.ids.uuid() });
  }
}
