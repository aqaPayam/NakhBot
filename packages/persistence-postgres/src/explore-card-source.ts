import type { UserSessionActor } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';

export function captureExploreCardSource(
  deliveryId: string | undefined,
  owner: UserSessionActor | undefined,
): string | undefined {
  if (deliveryId === undefined) return undefined;
  if (owner === undefined)
    throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(deliveryId)
  )
    throw new ApplicationError('discovery_unavailable', 'error.discovery.unavailable', 403);
  return deliveryId;
}

/** Caller holds the shared pair and sorted User/Account locks and has checked
 * the current product session. A card cannot select a later account life. */
export async function requireDeliveredExploreSource(
  transaction: NakhDatabase,
  deliveryId: string,
  viewerUserId: string,
  targetUserId: string,
): Promise<void> {
  const result = await sql<{ id: string }>`
    SELECT delivery.id FROM discovery.candidate_deliveries delivery
    WHERE delivery.id=${deliveryId}::uuid
      AND delivery.viewer_user_id=${viewerUserId}::uuid
      AND delivery.target_user_id=${targetUserId}::uuid
      AND delivery.mode='explore' AND delivery.state='delivered'
      AND NOT EXISTS (
        SELECT 1 FROM identity.account_deletion_records root
        WHERE root.user_id IN (${viewerUserId}::uuid,${targetUserId}::uuid)
          AND root.requested_at>=delivery.reserved_at
      )
    FOR SHARE OF delivery
  `.execute(transaction);
  if (result.rows.length !== 1)
    throw new ApplicationError('discovery_unavailable', 'error.discovery.unavailable', 403);
}
