import { ApplicationError, type NormalizedUserPair } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { lockUserPair } from './pair-lock.js';

/** Pair, stable identities, then Accounts: deletion fences precede transport receipts.
 * Other capability/profile rules remain with each command's existing policy. */
export async function lockNakhLifecyclePair(
  transaction: NakhDatabase,
  senderUserId: string,
  receiverUserId: string,
): Promise<NormalizedUserPair> {
  const pair = await lockUserPair(transaction, senderUserId, receiverUserId);
  const users = [pair.userLowId, pair.userHighId];
  await transaction
    .selectFrom('identity.users')
    .select('id')
    .where('id', 'in', users)
    .orderBy('id')
    .forNoKeyUpdate()
    .execute();
  const accounts = await transaction
    .selectFrom('identity.accounts')
    .select(['user_id', 'state'])
    .where('user_id', 'in', users)
    .orderBy('user_id')
    .forUpdate()
    .execute();
  if (accounts.length !== 2 || accounts.some((account) => account.state === 'deleted'))
    throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);
  return pair;
}
