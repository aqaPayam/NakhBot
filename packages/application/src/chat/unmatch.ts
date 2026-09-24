import type { UnmatchCommand, UnmatchResult } from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';

export type UnmatchWrite = Readonly<{
  command: UnmatchCommand;
  matchId: string;
  eventId: string;
}>;

export interface UnmatchStore {
  unmatch(write: UnmatchWrite): Promise<UnmatchResult>;
}

export interface UnmatchReferenceResolver {
  resolveMatchAction(token: string, userId: string): Promise<string | undefined>;
}

export class UnmatchHandler {
  public constructor(
    private readonly store: UnmatchStore,
    private readonly references: UnmatchReferenceResolver,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: UnmatchCommand): Promise<UnmatchResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const matchId = await this.references.resolveMatchAction(
      command.data.matchActionToken,
      command.actor.userId,
    );
    if (matchId === undefined)
      throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
    return this.store.unmatch({ command, matchId, eventId: this.ids.uuid() });
  }
}
