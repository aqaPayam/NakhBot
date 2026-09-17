import { sql } from 'kysely';

import { normalizeUserPair, type NormalizedUserPair } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

/** Shared transaction-scoped lock for every writer that changes facts about a user pair. */
export async function lockUserPair(
  database: NakhDatabase,
  leftUserId: string,
  rightUserId: string,
): Promise<NormalizedUserPair> {
  const pair = normalizeUserPair(leftUserId, rightUserId);
  await sql`SELECT interaction.lock_user_pair(${pair.userLowId}::uuid, ${pair.userHighId}::uuid)`.execute(
    database,
  );
  return pair;
}
