import { sql } from 'kysely';
import type { UserSessionActor } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { lockNakhLifecyclePair } from './nakh-lifecycle-authority.js';
import { requireCurrentUserSession } from './user-session-store.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function denied(): never {
  throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 403);
}
/** Ordinary profile access requires the exact received, viewed, still-actionable
 * Nakh. Safety evidence uses its separate historical-source policy. */
export async function requireNakhProfileSource(
  tx: NakhDatabase,
  actor: UserSessionActor,
  nakhId: string,
): Promise<{ targetId: string; flowId: string }> {
  const owner = Object.freeze({ ...actor });
  if (!tx.isTransaction || owner.kind !== 'user' || !UUID.test(nakhId)) denied();
  const initial = await tx
    .selectFrom('nakh.nakhes')
    .select(['sender_user_id', 'receiver_user_id', 'nakh_flow_id'])
    .where('id', '=', nakhId)
    .executeTakeFirst();
  if (!initial || initial.receiver_user_id !== owner.userId) denied();
  await lockNakhLifecyclePair(tx, initial.sender_user_id, owner.userId, initial.nakh_flow_id);
  await requireCurrentUserSession(tx, owner.userId, owner);
  const valid = (
    await sql<{ valid: boolean }>`SELECT EXISTS(
  SELECT 1 FROM nakh.nakhes n JOIN nakh.current_flow_lives f ON f.id=n.nakh_flow_id
   AND f.sender_user_id=n.sender_user_id AND f.receiver_user_id=n.receiver_user_id
  JOIN identity.accounts receiver ON receiver.user_id=n.receiver_user_id
  JOIN identity.accounts sender ON sender.user_id=n.sender_user_id
  JOIN profile.profiles p ON p.user_id=sender.user_id
  WHERE n.id=${nakhId}::uuid AND n.receiver_user_id=${owner.userId}::uuid
   AND n.sender_user_id=${initial.sender_user_id}::uuid AND n.nakh_flow_id=${initial.nakh_flow_id}::uuid
   AND n.status='seen' AND n.seen_at<=clock_timestamp() AND n.expires_at>clock_timestamp()
   AND receiver.state='active' AND receiver.product_epoch=${owner.productEpoch}
   AND sender.state='active' AND p.completion_status='complete'
   AND EXISTS(SELECT 1 FROM nakh.nakh_receiver_actions a WHERE a.nakh_id=n.id
     AND a.receiver_user_id=receiver.user_id AND a.action_type='view_profile' AND a.created_at=n.seen_at)
   AND NOT EXISTS(SELECT 1 FROM interaction.user_pair_states pair
     WHERE pair.user_low_id=LEAST(receiver.user_id,sender.user_id) AND pair.user_high_id=GREATEST(receiver.user_id,sender.user_id))
 ) AS valid`.execute(tx)
  ).rows[0]!.valid;
  if (!valid) denied();
  return { targetId: initial.sender_user_id, flowId: initial.nakh_flow_id };
}
