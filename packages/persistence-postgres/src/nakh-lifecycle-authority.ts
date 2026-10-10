import { ApplicationError, type NormalizedUserPair } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { lockUserPair, lockUserPairAccounts } from './pair-lock.js';

/** Pair, stable identities, then Accounts: deletion fences precede transport receipts.
 * Other capability/profile rules remain with each command's existing policy. */
export async function lockNakhLifecyclePair(
  transaction: NakhDatabase,
  senderUserId: string,
  receiverUserId: string,
  originalFlowId?: string,
): Promise<NormalizedUserPair> {
  const pair = await lockUserPair(transaction, senderUserId, receiverUserId);
  const accounts = await lockUserPairAccounts(transaction, pair);
  if (accounts.length !== 2 || accounts.some((account) => account.state === 'deleted'))
    throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);
  if (originalFlowId !== undefined) {
    const original = await transaction
      .selectFrom('nakh.current_flow_lives')
      .select('id')
      .where('id', '=', originalFlowId)
      .where('sender_user_id', '=', senderUserId)
      .where('receiver_user_id', '=', receiverUserId)
      .executeTakeFirst();
    if (original === undefined)
      throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 409);
  }
  return pair;
}
