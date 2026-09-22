import type { CreateDirectNakhCommand, DirectNakhResult } from '@nakh/contracts';
import { ApplicationError, type IdGenerator, validateNakhText } from '@nakh/domain';

export type CreateDirectNakhWrite = Readonly<{
  command: CreateDirectNakhCommand;
  flowId: string;
  nakhId: string;
  creditTransactionId: string;
  historyId: string;
  flowEventId: string;
  deliveredEventId: string;
}>;

export interface DirectNakhStore {
  createDirect(write: CreateDirectNakhWrite): Promise<DirectNakhResult>;
}

export class CreateDirectNakhHandler {
  public constructor(
    private readonly store: DirectNakhStore,
    private readonly ids: IdGenerator,
  ) {}

  public execute(command: CreateDirectNakhCommand): Promise<DirectNakhResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    validateNakhText(command.data.text);
    return this.store.createDirect({
      command,
      flowId: this.ids.uuid(),
      nakhId: this.ids.uuid(),
      creditTransactionId: this.ids.uuid(),
      historyId: this.ids.uuid(),
      flowEventId: this.ids.uuid(),
      deliveredEventId: this.ids.uuid(),
    });
  }
}
