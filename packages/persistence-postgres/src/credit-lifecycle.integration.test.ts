import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import {
  PostgresCreditLedgerStore,
  type AppendCreditTransactionInput,
} from './credit-ledger-store.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 original credit lifecycle provenance', () => {
  let database: NakhDatabase, store: PostgresCreditLedgerStore;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_credit_provenance');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 10000,
    });
    store = new PostgresCreditLedgerStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  function write(userId: string): AppendCreditTransactionInput {
    return {
      transactionId: randomUUID(),
      userId,
      transactionType: 'admin_adjustment' as const,
      amount: 10n,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    };
  }
  async function user(): Promise<string> {
    const id = await createReportUser(database, true),
      at = new Date();
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: id, created_at: at, updated_at: at })
      .execute();
    return id;
  }
  it('commits one original epoch-zero credit under twenty-way replay without rewriting its chain', async () => {
    const id = await user(),
      input = write(id);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.append({ ...input, transactionId: randomUUID() })),
    );
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const rows = await database
      .selectFrom('billing.credit_transactions')
      .selectAll()
      .where('user_id', '=', id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      product_epoch: 0,
      balance_before: '0',
      balance_after: '10',
      account_version: 2,
    });
    expect(await store.getBalance(id)).toEqual({ balance: 10n, version: 2 });
    await expect(
      database
        .updateTable('billing.credit_transactions')
        .set({ product_epoch: 1 })
        .where('id', '=', results[0]!.transactionId)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(store.append({ ...input, amount: 11n })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
  it('denies projection rebinding and deletion, including an empty projection', async () => {
    const id = await user();
    await expect(
      database
        .updateTable('billing.credit_accounts')
        .set({ product_epoch: 1 })
        .where('user_id', '=', id)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database
        .updateTable('billing.credit_accounts')
        .set({ created_at: new Date(0) })
        .where('user_id', '=', id)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database.deleteFrom('billing.credit_accounts').where('user_id', '=', id).execute(),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await store.getBalance(id)).toEqual({ balance: 0n, version: 1 });
  });
  it('preserves old money after a real tombstone and denies new credit and replay', async () => {
    let input: ReturnType<typeof write>;
    const fixture = await createDeletionFixture(database, async (id) => {
      await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${id}::uuid`.execute(
        database,
      );
      input = write(id);
      await store.append(input);
    });
    const before = await database
      .selectFrom('billing.credit_transactions')
      .selectAll()
      .where('user_id', '=', fixture.userId)
      .execute();
    await expect(store.append(input!)).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(store.append(write(fixture.userId))).rejects.toMatchObject({
      code: 'capability_denied',
    });
    await expect(
      database
        .updateTable('billing.credit_accounts')
        .set({ balance: '0', version: 3 })
        .where('user_id', '=', fixture.userId)
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
    expect(await store.getBalance(fixture.userId)).toEqual({ balance: 10n, version: 2 });
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('user_id', '=', fixture.userId)
        .execute(),
    ).toEqual(before);
  });
  it('rechecks final current authority at deferred commit and rolls back the entire credit', async () => {
    const id = await user();
    await expect(
      database.transaction().execute(async (tx) => {
        await tx
          .insertInto('billing.credit_transactions')
          .values({
            id: randomUUID(),
            credit_account_id: id,
            user_id: id,
            product_epoch: 0,
            account_version: 2,
            transaction_type: 'admin_adjustment',
            amount: '10',
            balance_before: '0',
            balance_after: '10',
            payment_record_id: null,
            pending_payment_id: null,
            feature_unlock_id: null,
            nakh_id: null,
            idempotency_key: randomUUID(),
            correlation_id: randomUUID(),
          })
          .execute();
        await tx
          .updateTable('billing.credit_accounts')
          .set({ balance: '10', version: 2, updated_at: new Date() })
          .where('user_id', '=', id)
          .execute();
        await sql`UPDATE identity.accounts SET state='restricted',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${id}::uuid`.execute(
          tx,
        );
      }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(await store.getBalance(id)).toEqual({ balance: 0n, version: 1 });
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .select('id')
        .where('user_id', '=', id)
        .execute(),
    ).toEqual([]);
    expect(
      (
        await database
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('active');
  });
  it('denies a forged ledger epoch and borrowed projection before admission', async () => {
    const id = await user(),
      other = await user();
    const row = {
      id: randomUUID(),
      credit_account_id: id,
      user_id: id,
      product_epoch: 0,
      account_version: 2,
      transaction_type: 'admin_adjustment' as const,
      amount: '10',
      balance_before: '0',
      balance_after: '10',
      payment_record_id: null,
      pending_payment_id: null,
      feature_unlock_id: null,
      nakh_id: null,
      idempotency_key: randomUUID(),
      correlation_id: randomUUID(),
    };
    await expect(
      database
        .insertInto('billing.credit_transactions')
        .values({ ...row, product_epoch: 1 })
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      database
        .insertInto('billing.credit_transactions')
        .values({ ...row, credit_account_id: other })
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      database
        .insertInto('billing.credit_transactions')
        .values({ ...row, transaction_type: 'refund', pending_payment_id: randomUUID() })
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
    expect(await store.getBalance(id)).toEqual({ balance: 0n, version: 1 });
  });
  it('waits behind a real committing tombstone and never appends late credit', async () => {
    await sql`CREATE FUNCTION public.m8_credit_pause_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='deleted' AND OLD.state<>'deleted' THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER m8_credit_pause_tombstone AFTER UPDATE ON identity.accounts FOR EACH ROW EXECUTE FUNCTION public.m8_credit_pause_tombstone()`.execute(
      database,
    );
    let id = '';
    const deletion = createDeletionFixture(database, async (owner) => {
      id = owner;
      await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${owner}::uuid`.execute(
        database,
      );
    });
    try {
      let sleeping = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        sleeping = (
          await sql<{
            sleeping: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep') AS sleeping`.execute(
            database,
          )
        ).rows[0]!.sleeping;
        if (sleeping) break;
        await delay(20);
      }
      expect(sleeping).toBe(true);
      const credit = store.append(write(id));
      const denied = expect(credit).rejects.toMatchObject({ code: 'capability_denied' });
      await deletion;
      await denied;
      expect(await store.getBalance(id)).toEqual({ balance: 0n, version: 1 });
      expect(
        await database
          .selectFrom('billing.credit_transactions')
          .select('id')
          .where('user_id', '=', id)
          .execute(),
      ).toEqual([]);
    } finally {
      await deletion;
      await sql`DROP TRIGGER m8_credit_pause_tombstone ON identity.accounts`.execute(database);
      await sql`DROP FUNCTION public.m8_credit_pause_tombstone()`.execute(database);
    }
  });
  it('upgrades populated migration 98 once and preserves every original financial field', async () => {
    const old = await createIsolatedTestDatabase(url!, 'm8_credit_upgrade');
    const directory = await mkdtemp(join(tmpdir(), 'nakh-credit-upgrade-'));
    const legacy = createDatabase({
      url: old.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 10000,
    });
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 98)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(old.url, directory);
      const id = await createReportUser(legacy, true),
        at = new Date(),
        transactionId = randomUUID();
      await legacy
        .insertInto('billing.credit_accounts')
        .values({ user_id: id, created_at: at, updated_at: at })
        .execute();
      await legacy.transaction().execute(async (tx) => {
        await sql`INSERT INTO billing.credit_transactions(id,credit_account_id,user_id,account_version,transaction_type,amount,balance_before,balance_after,idempotency_key,correlation_id)
          VALUES(${transactionId}::uuid,${id}::uuid,${id}::uuid,2,'admin_adjustment',13,0,13,${randomUUID()},${randomUUID()}::uuid)`.execute(
          tx,
        );
        await sql`UPDATE billing.credit_accounts SET balance=13,version=2 WHERE user_id=${id}::uuid`.execute(
          tx,
        );
      });
      const previousCredit = await legacy
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('id', '=', transactionId)
        .executeTakeFirstOrThrow();
      const previousAccount = await legacy
        .selectFrom('billing.credit_accounts')
        .selectAll()
        .where('user_id', '=', id)
        .executeTakeFirstOrThrow();
      const upgrades = await Promise.all(
        Array.from({ length: 20 }, () => runMigrations(old.url, resolve('migrations'))),
      );
      expect(upgrades.flatMap((result) => result.applied)).toEqual([
        '000099_m8_credit_lifecycle_provenance.sql',
        '000100_m8_deletion_lifecycle_binding.sql',
        '000101_m8_credit_epoch_partition.sql',
        '000102_m8_support_epoch_closure.sql',
        '000103_m8_support_closure_proof_view.sql',
      ]);
      expect(
        await legacy
          .selectFrom('billing.credit_transactions')
          .selectAll()
          .where('id', '=', transactionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ ...previousCredit, product_epoch: 0 });
      expect(
        await legacy
          .selectFrom('billing.credit_accounts')
          .selectAll()
          .where('user_id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ ...previousAccount, product_epoch: 0 });
      expect(await verifyMigrations(old.url, resolve('migrations/verify'))).toContain(
        '000099_m8_credit_lifecycle_provenance.sql',
      );
      expect((await runMigrations(old.url, resolve('migrations'))).applied).toEqual([]);
      const appended = await new PostgresCreditLedgerStore(legacy).append({
        ...write(id),
        amount: 1n,
      });
      expect(appended).toMatchObject({ balanceBefore: 13n, balanceAfter: 14n, accountVersion: 3 });
    } finally {
      await legacy.destroy();
      await old.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
