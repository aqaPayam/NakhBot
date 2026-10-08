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

/** Resolve immutable ownership without taking an asset lock before the identity.
 * Missing work is unavailable; existing work requires current Account authority. */
export async function lockMediaAssetOwnerInTransaction(
  transaction: NakhDatabase,
  assetId: string,
): Promise<boolean> {
  const asset = await transaction
    .selectFrom('media.media_assets')
    .select('owner_user_id')
    .where('id', '=', assetId)
    .executeTakeFirst();
  if (asset === undefined) return false;
  await transaction
    .selectFrom('identity.users')
    .select('id')
    .where('id', '=', asset.owner_user_id)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  await requireMediaAccountInTransaction(transaction, asset.owner_user_id);
  return true;
}
