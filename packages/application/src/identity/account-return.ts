import type {
  AccountControlLife,
  AccountControlGrant,
} from '../security/account-control-session.js';
import type { ReturnAccountCommand, ReturnAccountResult } from '@nakh/contracts';

/** Own authenticated limited control only. Approval and product sessions are separate. */
export interface AccountReturnStore {
  return(command: ReturnAccountCommand): Promise<ReturnAccountResult>;
}

/** Trusted primary ingress only. The opaque grant reference is authenticated for
 * the actual sender before lookup; native facts supply its original epoch. */
export interface AccountReturnGrantStore {
  issue(life: AccountControlLife, requestId: string): Promise<AccountControlGrant | undefined>;
  findForReturn(userId: string, grantId: string): Promise<AccountControlGrant | undefined>;
}
