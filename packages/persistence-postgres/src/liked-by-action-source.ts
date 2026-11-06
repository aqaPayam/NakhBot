import { sql } from 'kysely';
import type { UserSessionActor } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { lockUserPair, lockUserPairAccounts } from './pair-lock.js';
import { requireCurrentUserSession } from './user-session-store.js';
import { lockAndValidatePaidActionTarget } from './paid-action-store.js';

export type ReceivedLikeActionSource = Readonly<{ likeId: string; unlockId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function unavailable(): never {
  throw new ApplicationError('unlock_unavailable', 'error.billing.unlock_unavailable', 409);
}
export function captureReceivedLikeActionSource(
  source: ReceivedLikeActionSource | undefined,
  owner: UserSessionActor | undefined,
): ReceivedLikeActionSource | undefined {
  if (source === undefined) return undefined;
  if (!owner || !UUID.test(source.likeId) || !UUID.test(source.unlockId)) unavailable();
  return Object.freeze({ likeId: source.likeId, unlockId: source.unlockId });
}
async function lockOriginalLike(
  tx: NakhDatabase,
  actor: UserSessionActor,
  likeId: string,
  expectedTarget?: string,
): Promise<string> {
  if (!tx.isTransaction || !UUID.test(likeId)) unavailable();
  const initial = await tx
    .selectFrom('interaction.current_like_lives')
    .select('sender_user_id')
    .where('id', '=', likeId)
    .where('receiver_user_id', '=', actor.userId)
    .executeTakeFirst();
  if (!initial || (expectedTarget !== undefined && initial.sender_user_id !== expectedTarget))
    unavailable();
  const pair = await lockUserPair(tx, actor.userId, initial.sender_user_id);
  const accounts = await lockUserPairAccounts(tx, pair);
  if (accounts.length !== 2 || accounts.some((a) => a.state !== 'active')) unavailable();
  await requireCurrentUserSession(tx, actor.userId, actor);
  const current = (
    await sql<{ current: boolean }>`SELECT EXISTS (
    SELECT 1 FROM interaction.current_like_lives incoming
    JOIN profile.profiles viewer ON viewer.user_id=incoming.receiver_user_id
    JOIN profile.profiles target ON target.user_id=incoming.sender_user_id
    JOIN identity.user_settings settings ON settings.user_id=viewer.user_id
    WHERE incoming.id=${likeId}::uuid AND incoming.receiver_user_id=${actor.userId}::uuid
      AND incoming.sender_user_id=${initial.sender_user_id}::uuid
      AND viewer.completion_status='complete' AND target.completion_status='complete'
      AND settings.visibility_enabled) AS current`.execute(tx)
  ).rows[0]!.current;
  if (!current) unavailable();
  return initial.sender_user_id;
}
/** Original identity/life admission happens before idempotency replay. A cached
 * successful interaction may already have closed its own Like; fresh writes
 * separately require its original actionable scope. */
export async function requireOriginalUnlockedLikeSource(
  tx: NakhDatabase,
  actor: UserSessionActor,
  source: ReceivedLikeActionSource,
  expectedTarget?: string,
): Promise<string> {
  if (!UUID.test(source.unlockId)) unavailable();
  const target = await lockOriginalLike(tx, actor, source.likeId, expectedTarget);
  const valid = (
    await sql<{ valid: boolean }>`SELECT EXISTS (
    SELECT 1 FROM interaction.feature_unlocks u
    JOIN interaction.feature_unlock_reference_anchors a ON a.id=u.id
    WHERE u.id=${source.unlockId}::uuid AND u.like_id=${source.likeId}::uuid
      AND u.payer_user_id=${actor.userId}::uuid AND u.feature_type='liked_by_profile_unlock'
      AND a.payer_user_id=u.payer_user_id AND a.payer_product_epoch=${actor.productEpoch}
      AND a.like_id=u.like_id AND a.feature_type=u.feature_type
      AND u.status='active' AND u.revoked_at IS NULL AND u.expired_at IS NULL
      AND u.unlocked_at<=clock_timestamp() AND (u.expires_at IS NULL OR u.expires_at>clock_timestamp())) AS valid`.execute(
      tx,
    )
  ).rows[0]!.valid;
  if (!valid) unavailable();
  return target;
}
/** Metadata only; no private name, location, body or photo is selected. */
export async function readLikedByAccess(
  database: NakhDatabase,
  actor: UserSessionActor,
  likeId: string,
): Promise<
  Readonly<{
    targetUserId: string;
    unlockId?: string;
    balance: string;
  }>
> {
  const owner = Object.freeze({ ...actor });
  return database.transaction().execute(async (tx) => {
    const targetUserId = await lockOriginalLike(tx, owner, likeId);
    await lockAndValidatePaidActionTarget(tx, owner.userId, { type: 'like', targetId: likeId });
    const unlock = await tx
      .selectFrom('interaction.feature_unlocks')
      .select('id')
      .where('like_id', '=', likeId)
      .where('payer_user_id', '=', owner.userId)
      .executeTakeFirst();
    if (unlock)
      await requireOriginalUnlockedLikeSource(
        tx,
        owner,
        { likeId, unlockId: unlock.id },
        targetUserId,
      );
    const account = await tx
      .selectFrom('billing.credit_accounts')
      .select('balance')
      .where('user_id', '=', owner.userId)
      .executeTakeFirst();
    if (!account) unavailable();
    return {
      targetUserId,
      balance: String(account.balance),
      ...(unlock ? { unlockId: unlock.id } : {}),
    };
  });
}
