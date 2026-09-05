import type { ConsumeGuestPreviewCommand, ConsumeGuestPreviewResult } from '@nakh/contracts';
import { ApplicationError, type Clock, type IdGenerator } from '@nakh/domain';

export type ConsumeGuestPreviewWrite = Readonly<{
  command: ConsumeGuestPreviewCommand;
  auditId: string;
  eventId: string;
  processedAt: Date;
}>;

export interface GuestPreviewStore {
  consumeGuestPreview(write: ConsumeGuestPreviewWrite): Promise<ConsumeGuestPreviewResult>;
}

export class ConsumeGuestPreviewHandler {
  public constructor(
    private readonly store: GuestPreviewStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(command: ConsumeGuestPreviewCommand): Promise<ConsumeGuestPreviewResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.store.consumeGuestPreview({
      command,
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    });
  }
}
