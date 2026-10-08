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

/** Caller owns the pair (and any sender counter). Stable identities precede
 * Accounts so Account-first safety writers can finish their FK KEY SHARE. */
export async function lockUserPairAccounts(
  database: NakhDatabase,
  pair: NormalizedUserPair,
): Promise<readonly Readonly<{ userId: string; state: string }>[]> {
  const users = [pair.userLowId, pair.userHighId];
  await database
    .selectFrom('identity.users')
    .select('id')
    .where('id', 'in', users)
    .orderBy('id')
    .forNoKeyUpdate()
    .execute();
  return database
    .selectFrom('identity.accounts')
    .select(['user_id as userId', 'state'])
    .where('user_id', 'in', users)
    .orderBy('user_id')
    .forUpdate()
    .execute();
}
