import type { InteractionResult, MarkNotInterestedCommand, SendLikeCommand } from '@nakh/contracts';
import { ApplicationError, type Clock, type IdGenerator } from '@nakh/domain';

export interface InteractionStore {
  sendLike(
    command: SendLikeCommand,
    generated: Readonly<{
      likeId: string;
      matchId: string;
      chatSessionId: string;
      auditId: string;
      eventId: string;
      occurredAt: Date;
    }>,
  ): Promise<InteractionResult>;
  markNotInterested(
    command: MarkNotInterestedCommand,
    generated: Readonly<{
      rejectionId: string;
      auditId: string;
      eventId: string;
      occurredAt: Date;
    }>,
  ): Promise<InteractionResult>;
}

function assertUser(actor: Readonly<{ kind: string }>): void {
  if (actor.kind !== 'user')
    throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}

export class SendLikeHandler {
  public constructor(
    private readonly store: InteractionStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public execute(command: SendLikeCommand): Promise<InteractionResult> {
    assertUser(command.actor);
    return this.store.sendLike(command, {
      likeId: this.ids.uuid(),
      matchId: this.ids.uuid(),
      chatSessionId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      occurredAt: this.clock.now(),
    });
  }
}

export class MarkNotInterestedHandler {
  public constructor(
    private readonly store: InteractionStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public execute(command: MarkNotInterestedCommand): Promise<InteractionResult> {
    assertUser(command.actor);
    return this.store.markNotInterested(command, {
      rejectionId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      occurredAt: this.clock.now(),
    });
  }
}
