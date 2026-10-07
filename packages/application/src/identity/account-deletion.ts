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
