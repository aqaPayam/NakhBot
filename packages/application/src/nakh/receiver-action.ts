import type { NakhActionResult, RejectNakhCommand, ViewNakhProfileCommand } from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';

export type ViewNakhProfileWrite = Readonly<{
  command: ViewNakhProfileCommand;
  actionId: string;
  historyId: string;
  eventId: string;
}>;

export interface NakhReceiverActionStore {
  viewProfile(write: ViewNakhProfileWrite): Promise<NakhActionResult>;
  reject(write: RejectNakhWrite): Promise<NakhActionResult>;
}

export type RejectNakhWrite = Readonly<{
  command: RejectNakhCommand;
  actionId: string;
  historyId: string;
  eventId: string;
}>;

export class ViewNakhProfileHandler {
  public constructor(
    private readonly store: NakhReceiverActionStore,
    private readonly ids: IdGenerator,
  ) {}

  public execute(command: ViewNakhProfileCommand): Promise<NakhActionResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.store.viewProfile({
      command,
      actionId: this.ids.uuid(),
      historyId: this.ids.uuid(),
      eventId: this.ids.uuid(),
    });
  }
}

export class RejectNakhHandler {
  public constructor(
    private readonly store: NakhReceiverActionStore,
    private readonly ids: IdGenerator,
  ) {}

  public execute(command: RejectNakhCommand): Promise<NakhActionResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.store.reject({
      command,
      actionId: this.ids.uuid(),
      historyId: this.ids.uuid(),
      eventId: this.ids.uuid(),
    });
  }
}
