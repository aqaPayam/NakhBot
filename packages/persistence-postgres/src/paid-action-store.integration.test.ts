import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SpendCreditsForPaidActionWrite } from '@nakh/application';

import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { seedValidMedia } from './media-fixtures.js';
import { runMigrations } from './migrations.js';
import { PostgresPaidActionStore } from './paid-action-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const manGenderId = '20000000-0000-4000-8000-000000000001';
const everyonePreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

async function createActiveUser(database: NakhDatabase): Promise<string> {
  const userId = randomUUID();
  const profileId = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({ user_id: userId, state: 'active', state_reason: null, state_changed_at: now })
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('profile.profiles')
    .values({
      id: profileId,
      user_id: userId,
      name: 'Paid action fixture',
      birth_year: new Date().getUTCFullYear() - 30,
      gender_option_id: manGenderId,
      gender_preference_id: everyonePreferenceId,
      relationship_goal_id: relationshipGoalId,
      country_id: countryId,
      province_id: provinceId,
      city_id: cityId,
      highlight: 'Paid action fixture',
      bio: null,
      completion_status: 'complete',
      ever_completed: true,
      completed_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await database
    .insertInto('billing.credit_accounts')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  const assetId = await seedValidMedia(database, userId);
  await database
    .insertInto('media.profile_photos')
    .values({
      id: randomUUID(),
      profile_id: profileId,
      asset_id: assetId,
      status: 'visible',
      is_primary: true,
      display_order: 0,
      created_at: now,
      updated_at: now,
      hidden_at: null,
      deleted_at: null,
    })
    .execute();
  return userId;
}

async function fund(database: NakhDatabase, userId: string): Promise<void> {
  await new PostgresCreditLedgerStore(database).append({
    transactionId: randomUUID(),
    userId,
    transactionType: 'admin_adjustment',
    amount: 10n,
    idempotencyKey: `test-funding:${randomUUID()}`,
    correlationId: randomUUID(),
  });
}

function write(
  userId: string,
  target: SpendCreditsForPaidActionWrite['target'],
): SpendCreditsForPaidActionWrite {
  return {
    featureUnlockId: randomUUID(),
    creditTransactionId: randomUUID(),
    outboxEventId: randomUUID(),
    userId,
    target,
    idempotencyKey: `paid-action:${randomUUID()}`,
    correlationId: randomUUID(),
  };
}

describe.skipIf(databaseUrl === undefined)('M4 credit-funded feature unlocks', () => {
  let database: NakhDatabase;
  let store: PostgresPaidActionStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 12,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
    store = new PostgresPaidActionStore(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('atomically spends four credits for one actionable received Like', async () => {
    const senderUserId = await createActiveUser(database);
    const receiverUserId = await createActiveUser(database);
    await fund(database, receiverUserId);
    const likeId = randomUUID();
    await database
      .insertInto('interaction.likes')
      .values({
        id: likeId,
        sender_user_id: senderUserId,
        receiver_user_id: receiverUserId,
        status: 'active',
        created_at: new Date(),
        closed_at: null,
      })
      .execute();
    const first = await store.spendCredits(
      write(receiverUserId, { type: 'like', targetId: likeId }),
    );
    const replay = await store.spendCredits(
      write(receiverUserId, { type: 'like', targetId: likeId }),
    );
    expect(first).toMatchObject({ featureType: 'liked_by_profile_unlock', replayed: false });
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    expect(await new PostgresCreditLedgerStore(database).getBalance(receiverUserId)).toMatchObject({
      balance: 6n,
    });
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .select(['transaction_type', 'amount', 'feature_unlock_id'])
        .where('feature_unlock_id', '=', first.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      transaction_type: 'spend_liked_by_unlock',
      amount: '-4',
      feature_unlock_id: first.id,
    });
  });

  it('converges simultaneous participants on one Match unlock and charges only the winner', async () => {
    const firstUserId = await createActiveUser(database);
    const secondUserId = await createActiveUser(database);
    await fund(database, firstUserId);
    await fund(database, secondUserId);
    const [userLowId, userHighId] = [firstUserId, secondUserId].sort();
    const firstLikeId = randomUUID();
    const secondLikeId = randomUUID();
    const matchId = randomUUID();
    const chatSessionId = randomUUID();
    const now = new Date();
    await database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('interaction.likes')
        .values([
          {
            id: firstLikeId,
            sender_user_id: firstUserId,
            receiver_user_id: secondUserId,
            status: 'closed_by_match',
            created_at: now,
            closed_at: now,
          },
          {
            id: secondLikeId,
            sender_user_id: secondUserId,
            receiver_user_id: firstUserId,
            status: 'closed_by_match',
            created_at: now,
            closed_at: now,
          },
        ])
        .execute();
      await transaction
        .insertInto('interaction.user_pair_states')
        .values({
          user_low_id: userLowId!,
          user_high_id: userHighId!,
          state: 'matched',
          reason_code: 'mutual_like',
          changed_at: now,
        })
        .execute();
      await transaction
        .insertInto('matching.matches')
        .values({
          id: matchId,
          user_low_id: userLowId!,
          user_high_id: userHighId!,
          source: 'mutual_like',
          source_like_a_id: firstLikeId,
          source_like_b_id: secondLikeId,
          source_nakh_id: null,
          status: 'active',
          created_at: now,
          closed_at: null,
        })
        .execute();
      await transaction
        .insertInto('matching.match_participants')
        .values([
          { match_id: matchId, user_id: firstUserId, joined_at: now },
          { match_id: matchId, user_id: secondUserId, joined_at: now },
        ])
        .execute();
      await transaction
        .insertInto('chat.chat_sessions')
        .values({
          id: chatSessionId,
          match_id: matchId,
          status: 'active',
          created_at: now,
          closed_at: null,
          closed_reason: null,
        })
        .execute();
      await transaction
        .insertInto('chat.chat_participants')
        .values([
          {
            chat_session_id: chatSessionId,
            user_id: firstUserId,
            last_read_at: null,
            muted_at: null,
            unlock_safety_warning_shown_at: null,
          },
          {
            chat_session_id: chatSessionId,
            user_id: secondUserId,
            last_read_at: null,
            muted_at: null,
            unlock_safety_warning_shown_at: null,
          },
        ])
        .execute();
    });

    const results = await Promise.all([
      store.spendCredits(write(firstUserId, { type: 'match', targetId: matchId })),
      store.spendCredits(write(secondUserId, { type: 'match', targetId: matchId })),
    ]);
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(1);
    const balances = await Promise.all([
      new PostgresCreditLedgerStore(database).getBalance(firstUserId),
      new PostgresCreditLedgerStore(database).getBalance(secondUserId),
    ]);
    expect(balances.map(({ balance }) => balance).sort((a, b) => Number(a - b))).toEqual([6n, 10n]);
    expect(
      await database
        .selectFrom('interaction.feature_unlocks')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('match_id', '=', matchId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '1' });
  });
});
