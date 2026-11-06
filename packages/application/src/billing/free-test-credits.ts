import type { GrantFreeTestCreditsCommand } from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';

export type FreeTestCreditWrite = Readonly<{
  command: GrantFreeTestCreditsCommand;
  transactionId: string;
  eventId: string;
}>;
export type FreeTestCreditResult = Readonly<{
  transactionId: string;
  balanceAfter: string;
  replayed: boolean;
}>;
export interface FreeTestCreditStore {
  grant(write: FreeTestCreditWrite): Promise<FreeTestCreditResult>;
}
export class GrantFreeTestCreditsHandler {
  public constructor(
    private readonly store: FreeTestCreditStore,
    private readonly ids: IdGenerator,
  ) {}
  public execute(command: GrantFreeTestCreditsCommand): Promise<FreeTestCreditResult> {
    const captured = structuredClone(command);
    if (captured.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.store.grant({
      command: captured,
      transactionId: this.ids.uuid(),
      eventId: this.ids.uuid(),
    });
  }
}
