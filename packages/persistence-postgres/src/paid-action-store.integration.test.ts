import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql, type Selectable } from 'kysely';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionableLikedByPage, SpendCreditsForPaidActionWrite } from '@nakh/application';

import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { createDatabase, type DatabaseSchema, type NakhDatabase } from './database.js';
import { seedValidMedia } from './media-fixtures.js';
import { runMigrations } from './migrations.js';
import { PostgresPaidActionStore } from './paid-action-store.js';
import { PostgresLikedByStore } from './liked-by-store.js';

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
    .insertInto('notification.notification_preferences')
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

  it('denies new and cached Like grants and pages after either original life changes', async () => {
    for (const cached of [false, true]) {
      const sender = await createActiveUser(database),
        receiver = await createActiveUser(database);
      await fund(database, receiver);
      const likeId = randomUUID();
      await database
        .insertInto('interaction.likes')
        .values({
          id: likeId,
          sender_user_id: sender,
          receiver_user_id: receiver,
          status: 'active',
          created_at: new Date(),
          closed_at: null,
        })
        .execute();
      const attempt = write(receiver, { type: 'like', targetId: likeId });
      const original = cached ? await store.spendCredits(attempt) : undefined;
      const inbox = new PostgresLikedByStore(database);
      const page = (): Promise<ActionableLikedByPage> =>
        inbox.readActionablePage({
          actor: { kind: 'user', userId: receiver },
          requestId: randomUUID(),
          limit: 20,
        });
      expect((await page()).rows.map((row) => row.likeId)).toEqual([likeId]);
      const snapshot = async (): Promise<{
        account: Selectable<DatabaseSchema['billing.credit_accounts']>;
        ledger: Selectable<DatabaseSchema['billing.credit_transactions']>[];
        grants: Selectable<DatabaseSchema['interaction.feature_unlocks']>[];
        notices: Selectable<DatabaseSchema['notification.notifications']>[];
      }> => ({
        account: await database
          .selectFrom('billing.credit_accounts')
          .selectAll()
          .where('user_id', '=', receiver)
          .executeTakeFirstOrThrow(),
        ledger: await database
          .selectFrom('billing.credit_transactions')
          .selectAll()
          .where('user_id', '=', receiver)
          .orderBy('id')
          .execute(),
        grants: await database
          .selectFrom('interaction.feature_unlocks')
          .selectAll()
          .where('like_id', '=', likeId)
          .orderBy('id')
          .execute(),
        notices: await database
          .selectFrom('notification.notifications')
          .selectAll()
          .where('user_id', '=', receiver)
          .orderBy('id')
          .execute(),
      });
      const before = await snapshot();
      const setEpoch = async (userId: string, epoch: number): Promise<void> =>
        database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            await connection
              .updateTable('identity.accounts')
              .set({ product_epoch: epoch })
              .where('user_id', '=', userId)
              .execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      for (const changed of [sender, receiver]) {
        // Negative corruption only; each original epoch is restored.
        await setEpoch(changed, 1);
        try {
          const pages = await Promise.all(Array.from({ length: 20 }, page));
          for (const row of pages) expect(row).toEqual({ totalCount: 0, rows: [], hasMore: false });
          await Promise.all(
            Array.from({ length: 20 }, () =>
              expect(
                store.spendCredits({
                  ...attempt,
                  featureUnlockId: randomUUID(),
                  creditTransactionId: randomUUID(),
                  outboxEventId: randomUUID(),
                }),
              ).rejects.toMatchObject({ code: 'unlock_unavailable' }),
            ),
          );
          expect(await snapshot()).toEqual(before);
        } finally {
          await setEpoch(changed, 0);
        }
        expect((await page()).rows.map((row) => row.likeId)).toEqual([likeId]);
        expect(await snapshot()).toEqual(before);
      }
      const recovered = await Promise.all(
        Array.from({ length: 20 }, () =>
          store.spendCredits({
            ...attempt,
            featureUnlockId: randomUUID(),
            creditTransactionId: randomUUID(),
            outboxEventId: randomUUID(),
          }),
        ),
      );
      expect(new Set(recovered.map((row) => row.id)).size).toBe(1);
      expect(recovered.filter((row) => !row.replayed)).toHaveLength(cached ? 0 : 1);
      if (original !== undefined)
        expect(recovered.every((row) => row.id === original.id)).toBe(true);
      expect((await snapshot()).account.balance).toBe('6');
      expect((await snapshot()).grants).toHaveLength(1);
    }
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
    expect(
      await database
        .selectFrom('interaction.like_reference_anchors')
        .select('id')
        .where('id', '=', likeId)
        .execute(),
    ).toEqual([]);
    const first = await store.spendCredits(
      write(receiverUserId, { type: 'like', targetId: likeId }),
    );
    const replay = await store.spendCredits(
      write(receiverUserId, { type: 'like', targetId: likeId }),
    );
    expect(first).toMatchObject({ featureType: 'liked_by_profile_unlock', replayed: false });
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    expect(
      await database
        .selectFrom('interaction.like_reference_anchors')
        .selectAll()
        .where('id', '=', likeId)
        .execute(),
    ).toEqual([
      {
        id: likeId,
        sender_user_id: senderUserId,
        receiver_user_id: receiverUserId,
        sender_product_epoch: 0,
        receiver_product_epoch: 0,
      },
    ]);
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
    expect(
      await database
        .selectFrom('notification.notifications')
        .select(['notification_type', 'category'])
        .where('user_id', '=', receiverUserId)
        .where('notification_type', '=', 'liked_by_profile_unlocked')
        .executeTakeFirstOrThrow(),
    ).toEqual({ notification_type: 'liked_by_profile_unlocked', category: 'like' });
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
    expect(
      await database
        .selectFrom('notification.notifications')
        .select(['notification_type'])
        .where('user_id', 'in', [firstUserId, secondUserId])
        .where('notification_type', 'in', ['chat_unlocked', 'safety_notice'])
        .execute(),
    ).toHaveLength(4);
    const snapshot = async (): Promise<{
      accounts: Selectable<DatabaseSchema['billing.credit_accounts']>[];
      ledger: Selectable<DatabaseSchema['billing.credit_transactions']>[];
      grants: Selectable<DatabaseSchema['interaction.feature_unlocks']>[];
      notices: Selectable<DatabaseSchema['notification.notifications']>[];
    }> => ({
      accounts: await database
        .selectFrom('billing.credit_accounts')
        .selectAll()
        .where('user_id', 'in', [firstUserId, secondUserId])
        .orderBy('user_id')
        .execute(),
      ledger: await database
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('user_id', 'in', [firstUserId, secondUserId])
        .orderBy('id')
        .execute(),
      grants: await database
        .selectFrom('interaction.feature_unlocks')
        .selectAll()
        .where('match_id', '=', matchId)
        .orderBy('id')
        .execute(),
      notices: await database
        .selectFrom('notification.notifications')
        .selectAll()
        .where('user_id', 'in', [firstUserId, secondUserId])
        .orderBy('id')
        .execute(),
    });
    const original = await snapshot();
    const setEpoch = async (userId: string, epoch: number): Promise<void> =>
      database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await connection
            .updateTable('identity.accounts')
            .set({ product_epoch: epoch })
            .where('user_id', '=', userId)
            .execute();
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    for (const changed of [firstUserId, secondUserId]) {
      await setEpoch(changed, 1);
      try {
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            expect(
              store.spendCredits(
                write(index % 2 ? firstUserId : secondUserId, { type: 'match', targetId: matchId }),
              ),
            ).rejects.toMatchObject({ code: 'unlock_unavailable' }),
          ),
        );
        expect(await snapshot()).toEqual(original);
      } finally {
        await setEpoch(changed, 0);
      }
      const replays = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.spendCredits(
            write(index % 2 ? firstUserId : secondUserId, { type: 'match', targetId: matchId }),
          ),
        ),
      );
      expect(replays.every((row) => row.replayed && row.id === results[0].id)).toBe(true);
      expect(await snapshot()).toEqual(original);
    }
  });
});
