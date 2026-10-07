import { ApplicationError } from '../foundation.js';
import type { AccountState } from './account.js';

/** Evidence must be secured before ordinary content is purged. Completion never grants return. */
export const ACCOUNT_DELETION_PHASES = [
  'shared_closure',
  'evidence_capture',
  'product_data',
  'media_objects',
  'ephemeral_access',
  'retention_manifest',
  'verification',
  'completed',
] as const;
export type AccountDeletionPhase = (typeof ACCOUNT_DELETION_PHASES)[number];

export function assertDeletionAdvance(
  current: AccountDeletionPhase,
  next: AccountDeletionPhase,
): void {
  const index = ACCOUNT_DELETION_PHASES.indexOf(current);
  if (
    index < 0 ||
    index === ACCOUNT_DELETION_PHASES.length - 1 ||
    ACCOUNT_DELETION_PHASES[index + 1] !== next
  )
    throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}

export type AccountReturnDecision =
  'allowed' | 'not_deleted' | 'purge_pending' | 'reactivation_denied' | 'safety_bar';

/** Fail closed: retained safety history cannot be bypassed by deleting and returning. */
export function evaluateAccountReturn(
  input: Readonly<{
    accountState: AccountState;
    purgeCompleted: boolean;
    reactivationAllowed: boolean;
    retainedSafetyBar: 'none' | 'restricted' | 'banned' | 'unresolved';
  }>,
): AccountReturnDecision {
  if (input.accountState !== 'deleted') return 'not_deleted';
  if (input.purgeCompleted !== true) return 'purge_pending';
  if (input.reactivationAllowed !== true) return 'reactivation_denied';
  if (input.retainedSafetyBar !== 'none') return 'safety_bar';
  return 'allowed';
}
