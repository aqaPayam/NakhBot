import type { ReturnAccountCommand, ReturnAccountResult } from '@nakh/contracts';

/** Own authenticated limited control only. Approval and product sessions are separate. */
export interface AccountReturnStore {
  return(command: ReturnAccountCommand): Promise<ReturnAccountResult>;
}
