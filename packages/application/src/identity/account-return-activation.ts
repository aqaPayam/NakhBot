import type { UserProductLife } from '../security/user-session.js';

export type AccountReturnActivationProof = UserProductLife &
  Readonly<{
    previousProductEpoch: number;
    returnAuditId: string;
  }>;

/** Server-inferred life only. The authority holds the canonical User/Account
 * locks through the bounded provider operation and binds the verified namespace. */
export interface AccountReturnActivationAuthority {
  withCurrentReturn(
    life: UserProductLife,
    namespaceHash: string,
    effect: (proof: AccountReturnActivationProof) => Promise<void>,
  ): Promise<void>;
}

export interface AccountReturnActivation {
  activate(life: UserProductLife): Promise<void>;
}
