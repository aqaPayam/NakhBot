import type {
  AccountDeletionStatus,
  CancelAccountDeletionCommand,
  CancelAccountDeletionResult,
  GetAccountDeletionStatusQuery,
  PrepareAccountDeletionQuery,
  PreparedAccountDeletion,
  RequestAccountDeletionCommand,
  RequestAccountDeletionResult,
} from '@nakh/contracts';
import type { AccountDeletionPhase } from '@nakh/domain';

/** Actor comes from authenticated ingress; there is no independently selectable subject. */
export interface AccountDeletionStore {
  prepare(query: PrepareAccountDeletionQuery): Promise<PreparedAccountDeletion>;
  request(command: RequestAccountDeletionCommand): Promise<RequestAccountDeletionResult>;
  cancel(command: CancelAccountDeletionCommand): Promise<CancelAccountDeletionResult>;
  status(query: GetAccountDeletionStatusQuery): Promise<AccountDeletionStatus | undefined>;
}

/** Keep decrypt/derive-only old keys for unexpired confirmations during rotation. */
export type DeletionConfirmationKeys = Readonly<{
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}>;

/** Internal mandatory work authority; never included in own-account status. */
export type AccountDeletionLease = Readonly<{
  deletionRecordId: string;
  userId: string;
  phase: AccountDeletionPhase;
  checkpointVersion: number;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: Date;
  attemptCount: number;
}>;
export const ACCOUNT_DELETION_FAILURE_CODES = [
  'deletion_phase_failed',
  'deletion_provider_unavailable',
  'deletion_evidence_pending',
  'deletion_verification_failed',
] as const;
export type AccountDeletionFailureCode = (typeof ACCOUNT_DELETION_FAILURE_CODES)[number];

export interface AccountDeletionWorkStore {
  claimDue(input: {
    workerId: string;
    limit: number;
    leaseMs: number;
  }): Promise<AccountDeletionLease[]>;
  renew(lease: AccountDeletionLease, leaseMs: number): Promise<AccountDeletionLease>;
  release(lease: AccountDeletionLease): Promise<void>;
  retry(
    lease: AccountDeletionLease,
    code: AccountDeletionFailureCode,
    delaySeconds: number,
  ): Promise<void>;
}
