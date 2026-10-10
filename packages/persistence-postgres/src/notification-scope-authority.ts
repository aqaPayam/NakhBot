import { sql } from 'kysely';
import type { NotificationType } from '@nakh/domain';
import type { NakhDatabase } from './database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type Notice = Readonly<{ user_id: string; notification_type: NotificationType; payload: unknown }>;

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

/** Only original, current product scopes authorize a product notice. The caller
 * locks these identities/Accounts, then resolves again before rendering/admission.
 * Closure notices convey the recipient's own terminal fact, never renewed access. */
export async function resolveNotificationScope(
  database: NakhDatabase,
  notice: Notice,
): Promise<readonly string[] | undefined> {
  const payload = object(notice.payload);
  switch (notice.notification_type) {
    case 'new_chat_message': {
      const messageId = identifier(payload?.messageId),
        chatSessionId = identifier(payload?.chatSessionId);
      if (messageId === undefined || chatSessionId === undefined) return undefined;
      const message = await database
        .selectFrom('chat.chat_messages as message')
        .innerJoin('chat.chat_participants as participant', (join) =>
          join
            .onRef('participant.chat_session_id', '=', 'message.chat_session_id')
            .on('participant.user_id', '=', notice.user_id),
        )
        .select('message.sender_user_id')
        .where('message.id', '=', messageId)
        .where('message.chat_session_id', '=', chatSessionId)
        .executeTakeFirst();
      return message?.sender_user_id == null ? undefined : [notice.user_id, message.sender_user_id];
    }
    case 'like_received': {
      const likeId = identifier(payload?.likeId);
      if (likeId === undefined) return undefined;
      const like = await database
        .selectFrom('interaction.likes')
        .select(['sender_user_id', 'receiver_user_id'])
        .where('id', '=', likeId)
        .where('receiver_user_id', '=', notice.user_id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      return like === undefined ? undefined : [like.sender_user_id, like.receiver_user_id];
    }
    case 'nakh_received': {
      const nakhId = identifier(payload?.nakhId);
      if (nakhId === undefined) return undefined;
      const nakh = await database
        .selectFrom('nakh.nakhes as delivered')
        .innerJoin('nakh.current_flow_lives as flow', 'flow.id', 'delivered.nakh_flow_id')
        .select(['delivered.sender_user_id', 'delivered.receiver_user_id'])
        .where('delivered.id', '=', nakhId)
        .where('delivered.receiver_user_id', '=', notice.user_id)
        .where('delivered.status', 'in', ['sent', 'seen'])
        .where('delivered.expires_at', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      return nakh === undefined ? undefined : [nakh.sender_user_id, nakh.receiver_user_id];
    }
    case 'pending_nakh_payment_reminder': {
      const pendingId = identifier(payload?.pendingNakhId);
      if (pendingId === undefined) return undefined;
      const pending = await database
        .selectFrom('nakh.pending_nakhes as pending')
        .innerJoin('nakh.current_flow_lives as flow', 'flow.id', 'pending.nakh_flow_id')
        .select(['flow.sender_user_id', 'flow.receiver_user_id'])
        .where('pending.id', '=', pendingId)
        .where('pending.sender_user_id', '=', notice.user_id)
        .where('flow.sender_user_id', '=', notice.user_id)
        .where('pending.status', '=', 'pending_payment')
        .where('pending.expires_at', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      return pending === undefined ? undefined : [pending.sender_user_id, pending.receiver_user_id];
    }
    case 'match_created': {
      const matchId = identifier(payload?.matchId);
      if (matchId === undefined) return undefined;
      const match = await database
        .selectFrom('matching.matches')
        .select(['user_low_id', 'user_high_id'])
        .where('id', '=', matchId)
        .where('status', '=', 'active')
        .where((eb) =>
          eb.or([eb('user_low_id', '=', notice.user_id), eb('user_high_id', '=', notice.user_id)]),
        )
        .executeTakeFirst();
      return match === undefined ? undefined : [match.user_low_id, match.user_high_id];
    }
    case 'liked_by_profile_unlocked': {
      const unlockId = identifier(payload?.featureUnlockId);
      if (unlockId === undefined) return undefined;
      const grant = await database
        .selectFrom('interaction.feature_unlocks as grant')
        .innerJoin('interaction.likes as like', 'like.id', 'grant.like_id')
        .select(['like.sender_user_id', 'like.receiver_user_id'])
        .where('grant.id', '=', unlockId)
        .where('grant.feature_type', '=', 'liked_by_profile_unlock')
        .where('grant.payer_user_id', '=', notice.user_id)
        .where('like.receiver_user_id', '=', notice.user_id)
        .where('like.status', '=', 'active')
        .where('grant.status', '=', 'active')
        .where((eb) =>
          eb.or([
            eb('grant.expires_at', 'is', null),
            eb('grant.expires_at', '>', sql<Date>`clock_timestamp()`),
          ]),
        )
        .executeTakeFirst();
      return grant === undefined ? undefined : [grant.sender_user_id, grant.receiver_user_id];
    }
    case 'safety_notice':
    case 'chat_unlocked': {
      // The unlock warning is product-scoped; generic safety notices remain critical.
      if (notice.notification_type === 'safety_notice' && payload?.featureUnlockId === undefined)
        return [notice.user_id];
      const unlockId = identifier(payload?.featureUnlockId);
      if (unlockId === undefined) return undefined;
      const grant = await database
        .selectFrom('interaction.feature_unlocks as grant')
        .innerJoin('matching.matches as match', 'match.id', 'grant.match_id')
        .select(['match.user_low_id', 'match.user_high_id'])
        .where('grant.id', '=', unlockId)
        .where('grant.feature_type', '=', 'chat_unlock')
        .where('grant.status', '=', 'active')
        .where('match.status', '=', 'active')
        .where((eb) =>
          eb.or([
            eb('match.user_low_id', '=', notice.user_id),
            eb('match.user_high_id', '=', notice.user_id),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb('grant.expires_at', 'is', null),
            eb('grant.expires_at', '>', sql<Date>`clock_timestamp()`),
          ]),
        )
        .executeTakeFirst();
      return grant === undefined ? undefined : [grant.user_low_id, grant.user_high_id];
    }
    case 'chat_closed': {
      const matchId = identifier(payload?.matchId);
      if (matchId === undefined) return undefined;
      const fact = (
        await sql<{ id: string }>`SELECT id FROM matching.match_lifecycle_facts
        WHERE id=${matchId}::uuid AND status IN ('closed','unmatched')
          AND ${notice.user_id}::uuid IN (user_low_id,user_high_id)`.execute(database)
      ).rows[0];
      return fact === undefined ? undefined : [notice.user_id];
    }
    case 'payment_success':
    case 'payment_failure':
    case 'report_result':
    case 'admin_notice':
    case 'ban_warning':
    case 'restriction_warning':
      return [notice.user_id];
  }
}
