import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

async function createCreditUser(database: NakhDatabase): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('billing.credit_accounts')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  return userId;
}

describe.skipIf(databaseUrl === undefined)('M4 PostgreSQL credit ledger', () => {
  let database: NakhDatabase;
  let store: PostgresCreditLedgerStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 8,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 2_000,
    });
    store = new PostgresCreditLedgerStore(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('installs exactly the four locked active package snapshots', async () => {
    expect(await store.getActivePackages()).toMatchObject([
      { code: 'starter', credits: 10n, stars: 10n, displayOrder: 1 },
      { code: 'plus', credits: 25n, stars: 20n, displayOrder: 2 },
      { code: 'best_value', credits: 50n, stars: 35n, displayOrder: 3 },
      { code: 'ultimate', credits: 100n, stars: 60n, displayOrder: 4 },
    ]);
  });

  it('appends one continuous immutable transaction and replays its business cause', async () => {
    const userId = await createCreditUser(database);
    const idempotencyKey = `admin-credit:${randomUUID()}`;
    const input = {
      transactionId: randomUUID(),
      userId,
      transactionType: 'admin_adjustment' as const,
      amount: 10n,
      idempotencyKey,
      correlationId: randomUUID(),
    };
    const first = await store.append(input);
    const replay = await store.append({ ...input, transactionId: randomUUID() });
    expect(first).toMatchObject({ balanceBefore: 0n, balanceAfter: 10n, accountVersion: 2 });
    expect(replay).toMatchObject({ transactionId: first.transactionId, replayed: true });
    expect(await store.getBalance(userId)).toEqual({ balance: 10n, version: 2 });
    await expect(
      store.append({ ...input, transactionId: randomUUID(), amount: 11n }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });

    await expect(
      database
        .updateTable('billing.credit_transactions')
        .set({ amount: '11' })
        .where('id', '=', first.transactionId)
        .execute(),
    ).rejects.toThrow();
    await expect(
      database
        .updateTable('billing.credit_accounts')
        .set({ balance: '999', version: 3, updated_at: new Date() })
        .where('user_id', '=', userId)
        .execute(),
    ).rejects.toThrow();
  });

  it('serializes exact-balance spends so only one can commit', async () => {
    const userId = await createCreditUser(database);
    await store.append({
      transactionId: randomUUID(),
      userId,
      transactionType: 'admin_adjustment',
      amount: 4n,
      idempotencyKey: `seed-credit:${randomUUID()}`,
      correlationId: randomUUID(),
    });
    const attempts = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((featureUnlockId) =>
        store.append({
          transactionId: randomUUID(),
          userId,
          transactionType: 'spend_chat_unlock',
          amount: -4n,
          idempotencyKey: `chat-unlock:${featureUnlockId}`,
          correlationId: randomUUID(),
          reference: { featureUnlockId },
        }),
      ),
    );
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status !== 'rejected') throw new Error('Expected one rejected credit spend.');
    expect(rejected.reason).toMatchObject({ code: 'insufficient_credits' });
    expect(await store.getBalance(userId)).toEqual({ balance: 0n, version: 3 });

    const rows = await database
      .selectFrom('billing.credit_transactions')
      .select(['account_version', 'balance_before', 'balance_after'])
      .where('user_id', '=', userId)
      .orderBy('account_version', 'asc')
      .execute();
    expect(rows).toEqual([
      { account_version: 2, balance_before: '0', balance_after: '4' },
      { account_version: 3, balance_before: '4', balance_after: '0' },
    ]);
  });
});
