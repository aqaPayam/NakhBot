import { ApplicationError, evaluateCapability } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

/** Caller holds the stable User lock before Account, then any Profile/media locks.
 * Check current authority before command receipts or delayed publication. */
export async function requireMediaAccountInTransaction(
  transaction: NakhDatabase,
  userId: string,
): Promise<void> {
  const account = await transaction
    .selectFrom('identity.accounts')
    .select('state')
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (
    account === undefined ||
    !evaluateCapability(
      { accountState: account.state, profileCompletion: null, visibilityEnabled: false },
      account.state === 'incomplete' ? 'continue_signup' : 'edit_profile',
    ).allowed
  )
    throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
}
