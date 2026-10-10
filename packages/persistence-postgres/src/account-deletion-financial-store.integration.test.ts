import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionFinancialStore } from './account-deletion-financial-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
const migration = '000101_m8_credit_epoch_partition.sql';
describe.skipIf(url === undefined)('M8 original financial epoch preservation and cutover', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, financial: PostgresAccountDeletionFinancialStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_financial_epochs');
    await runMigrations(isolated.url, resolve('migrations'));
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(migration);
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 10000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    financial = new PostgresAccountDeletionFinancialStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day'`.execute(
      database,
    );
  });
  async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
    const leases = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(leases).toHaveLength(1);
    return leases[0]!;
  }
  async function scene(
    leaseMs = 120000,
  ): Promise<{ userId: string; recordId: string; lease: AccountDeletionLease }> {
    const item = await createDeletionFixture(database, async (userId) => {
      await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${userId}::uuid`.execute(
        database,
      );
      const ledger = new PostgresCreditLedgerStore(database);
      for (const amount of [13n, 7n])
        await ledger.append({
          transactionId: randomUUID(),
          userId,
          transactionType: 'admin_adjustment',
          amount,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
        });
    });
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(await claim());
    await checkpoints.finishEvidence(await claim());
    return { ...item, lease: await claim(leaseMs) };
  }
  async function money(userId: string, db = database): Promise<unknown> {
    return (
      await sql<{ snapshot: unknown }>`SELECT jsonb_build_object(
      'projection',(SELECT to_jsonb(row) FROM billing.credit_accounts row WHERE user_id=${userId}::uuid),
      'epochs',(SELECT jsonb_agg(to_jsonb(row) ORDER BY product_epoch) FROM billing.credit_epoch_accounts row WHERE user_id=${userId}::uuid),
      'ledger',(SELECT jsonb_agg(to_jsonb(row) ORDER BY product_epoch,account_version) FROM billing.credit_transactions row WHERE user_id=${userId}::uuid),
      'closures',(SELECT jsonb_agg(to_jsonb(row)) FROM billing.credit_epoch_closures row WHERE user_id=${userId}::uuid)) AS snapshot`.execute(
        db,
      )
    ).rows[0]!.snapshot;
  }
  it('twenty retries preserve every original money field and prepare one empty next life without return', async () => {
    const item = await scene();
    const before = await database
      .selectFrom('billing.credit_accounts')
      .selectAll()
      .where('user_id', '=', item.userId)
      .executeTakeFirstOrThrow();
    const ledger = await database
      .selectFrom('billing.credit_transactions')
      .selectAll()
      .where('user_id', '=', item.userId)
      .orderBy('account_version')
      .execute();
    const owner = await database
      .selectFrom('identity.accounts')
      .selectAll()
      .where('user_id', '=', item.userId)
      .executeTakeFirstOrThrow();
    expect(before).toMatchObject({ balance: '20', version: 3, product_epoch: 0 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => financial.prepareCreditEpoch(item.lease)),
    );
    expect(results.filter((row) => !row.replayed)).toHaveLength(1);
    const receipt = await database
      .selectFrom('billing.credit_epoch_closures')
      .selectAll()
      .where('deletion_record_id', '=', item.recordId)
      .executeTakeFirstOrThrow();
    expect(receipt).toMatchObject({
      user_id: item.userId,
      product_epoch: 0,
      next_product_epoch: 1,
      balance: '20',
      account_version: 3,
      projection_created_at: before.created_at,
      projection_updated_at: before.updated_at,
    });
    expect(
      await database
        .selectFrom('billing.credit_epoch_accounts')
        .selectAll()
        .where('user_id', '=', item.userId)
        .where('product_epoch', '=', 0)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    const next = {
      ...before,
      product_epoch: 1,
      balance: '0',
      version: 1,
      updated_at: receipt.prepared_at,
    };
    expect(
      await database
        .selectFrom('billing.credit_accounts')
        .selectAll()
        .where('user_id', '=', item.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual(next);
    expect(
      await database
        .selectFrom('billing.credit_epoch_accounts')
        .selectAll()
        .where('user_id', '=', item.userId)
        .where('product_epoch', '=', 1)
        .executeTakeFirstOrThrow(),
    ).toEqual(next);
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('user_id', '=', item.userId)
        .orderBy('account_version')
        .execute(),
    ).toEqual(ledger);
    expect(
      await database
        .selectFrom('identity.accounts')
        .selectAll()
        .where('user_id', '=', item.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual(owner);
    expect(
      (
        await sql<{
          phase: string;
          checkpoint_version: number;
          product_purged_at: Date | null;
          completed_at: Date | null;
          reactivation_allowed: boolean;
        }>`SELECT phase,checkpoint_version,product_purged_at,completed_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${item.recordId}::uuid`.execute(
          database,
        )
      ).rows[0],
    ).toEqual({
      phase: 'product_data',
      checkpoint_version: 3,
      product_purged_at: null,
      completed_at: null,
      reactivation_allowed: false,
    });
    const audit = await database
      .selectFrom('platform.audit_logs')
      .select(['event_type', 'metadata', 'actor_type'])
      .where('id', '=', receipt.audit_id)
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({
      event_type: 'account.deletion-credit-epoch-prepared.v1',
      metadata: { kind: 'credit_epoch' },
      actor_type: 'system',
    });
    expect(
      (
        await sql<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM platform.outbox_events WHERE aggregate_id=${item.recordId}::uuid AND event_type='account.deletion-credit-epoch-prepared.v1'`.execute(
          database,
        )
      ).rows[0]!.count,
    ).toBe(1);
    await database
      .deleteFrom('platform.outbox_events')
      .where('id', '=', receipt.event_id)
      .execute();
    await work.release(item.lease);
    const reclaimed = await claim();
    expect(reclaimed.leaseGeneration).toBe(item.lease.leaseGeneration + 1);
    expect(await financial.prepareCreditEpoch(reclaimed)).toEqual({ replayed: true });
    await expect(financial.prepareCreditEpoch(item.lease)).rejects.toMatchObject({ status: 409 });
  });
  it('requires the exact phase, owner, generation and original root before changing money', async () => {
    const item = await scene(),
      before = await money(item.userId),
      other = await createReportUser(database);
    for (const lease of [
      { ...item.lease, phase: 'shared_closure' as const, checkpointVersion: 1 },
      { ...item.lease, userId: other },
      { ...item.lease, leaseOwner: randomUUID() },
      { ...item.lease, leaseGeneration: item.lease.leaseGeneration + 1 },
    ]) {
      await expect(financial.prepareCreditEpoch(lease)).rejects.toMatchObject({ status: 409 });
      expect(await money(item.userId)).toEqual(before);
    }
    await expect(
      sql`UPDATE billing.credit_accounts SET product_epoch=1,balance=0,version=1 WHERE user_id=${item.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await money(item.userId)).toEqual(before);
  });
  it('keeps old epochs and receipts immutable and rejects extra resets, old writes and premature return', async () => {
    const item = await scene();
    await financial.prepareCreditEpoch(item.lease);
    const before = await money(item.userId);
    await expect(
      sql`UPDATE billing.credit_epoch_accounts SET balance=21 WHERE user_id=${item.userId}::uuid AND product_epoch=0`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      sql`DELETE FROM billing.credit_epoch_accounts WHERE user_id=${item.userId}::uuid AND product_epoch=0`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`UPDATE billing.credit_epoch_closures SET balance=21 WHERE deletion_record_id=${item.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`DELETE FROM billing.credit_epoch_closures WHERE deletion_record_id=${item.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    for (const epoch of [0, 2])
      await expect(
        sql`UPDATE billing.credit_accounts SET product_epoch=${epoch},balance=0,version=1 WHERE user_id=${item.userId}::uuid`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`UPDATE billing.credit_accounts SET balance=1 WHERE user_id=${item.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      sql`UPDATE billing.credit_transactions SET amount=amount+1 WHERE user_id=${item.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      new PostgresCreditLedgerStore(database).append({
        transactionId: randomUUID(),
        userId: item.userId,
        transactionType: 'admin_adjustment',
        amount: 1n,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      sql`INSERT INTO billing.credit_transactions(id,credit_account_id,user_id,product_epoch,account_version,transaction_type,amount,balance_before,balance_after,idempotency_key,correlation_id)
      VALUES(${randomUUID()}::uuid,${item.userId}::uuid,${item.userId}::uuid,1,2,'admin_adjustment',1,0,1,${randomUUID()},${randomUUID()}::uuid)`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      sql`UPDATE identity.accounts SET state='guest',product_epoch=1,version=version+1 WHERE user_id=${item.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await money(item.userId)).toEqual(before);
  });
  it.each(['audit', 'event'] as const)(
    'rolls back every financial write when its required %s is absent',
    async (kind) => {
      const item = await scene(),
        before = await money(item.userId);
      const table = kind === 'audit' ? 'platform.audit_logs' : 'platform.outbox_events';
      await sql`CREATE FUNCTION public.m8_drop_financial_proof() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='account.deletion-credit-epoch-prepared.v1' THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      try {
        await sql`CREATE TRIGGER m8_drop_financial_proof BEFORE INSERT ON ${sql.table(table)} FOR EACH ROW EXECUTE FUNCTION public.m8_drop_financial_proof()`.execute(
          database,
        );
        await expect(financial.prepareCreditEpoch(item.lease)).rejects.toMatchObject({
          code: kind === 'audit' ? '23503' : '23514',
        });
        expect(await money(item.userId)).toEqual(before);
      } finally {
        await sql`DROP TRIGGER m8_drop_financial_proof ON ${sql.table(table)}`.execute(database);
        await sql`DROP FUNCTION public.m8_drop_financial_proof()`.execute(database);
      }
      expect(await financial.prepareCreditEpoch(item.lease)).toEqual({ replayed: false });
    },
  );
  it('rechecks actual commit time after a pause and lets a new lease resume without duplicating history', async () => {
    const item = await scene(1000),
      before = await money(item.userId);
    await expect(
      database.transaction().execute(async (tx) => {
        expect(
          await new PostgresAccountDeletionFinancialStore(tx).prepareCreditEpoch(item.lease),
        ).toEqual({ replayed: false });
        await sql`SELECT pg_sleep(1.2)`.execute(tx);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await money(item.userId)).toEqual(before);
    const reclaimed = await claim();
    expect(reclaimed.leaseGeneration).toBe(item.lease.leaseGeneration + 1);
    await expect(financial.prepareCreditEpoch(item.lease)).rejects.toMatchObject({ status: 409 });
    expect(await financial.prepareCreditEpoch(reclaimed)).toEqual({ replayed: false });
    expect(await financial.prepareCreditEpoch(reclaimed)).toEqual({ replayed: true });
    expect(
      await database
        .selectFrom('billing.credit_epoch_closures')
        .select('deletion_record_id')
        .where('user_id', '=', item.userId)
        .execute(),
    ).toEqual([{ deletion_record_id: item.recordId }]);
  });
  it.each([false, true])(
    'upgrades populated migration 100 once and rejects a legacy gap (gap=%s)',
    async (gap) => {
      const old = await createIsolatedTestDatabase(url!, 'm8_financial_upgrade');
      const directory = await mkdtemp(join(tmpdir(), 'nakh-financial-epoch-'));
      const legacy = createDatabase({
        url: old.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 10000,
      });
      try {
        for (const file of await readdir(resolve('migrations')))
          if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 100)
            await copyFile(join(resolve('migrations'), file), join(directory, file));
        await runMigrations(old.url, directory);
        const id = await createReportUser(legacy, true),
          at = new Date();
        await legacy
          .insertInto('billing.credit_accounts')
          .values({ user_id: id, created_at: at, updated_at: at })
          .execute();
        await legacy.transaction().execute(async (tx) => {
          await sql`INSERT INTO billing.credit_transactions(id,credit_account_id,user_id,account_version,transaction_type,amount,balance_before,balance_after,idempotency_key,correlation_id)
          VALUES(${randomUUID()}::uuid,${id}::uuid,${id}::uuid,${gap ? 4 : 2},'admin_adjustment',13,0,13,${randomUUID()},${randomUUID()}::uuid)`.execute(
            tx,
          );
          await sql`UPDATE billing.credit_accounts SET balance=13,version=${gap ? 4 : 2} WHERE user_id=${id}::uuid`.execute(
            tx,
          );
        });
        const projection = await legacy
          .selectFrom('billing.credit_accounts')
          .selectAll()
          .where('user_id', '=', id)
          .executeTakeFirstOrThrow();
        const ledger = await legacy
          .selectFrom('billing.credit_transactions')
          .selectAll()
          .where('user_id', '=', id)
          .execute();
        if (gap) {
          await expect(runMigrations(old.url, resolve('migrations'))).rejects.toMatchObject({
            code: '23514',
          });
          expect(
            (
              await sql<{
                epoch_table: string | null;
                closure_table: string | null;
              }>`SELECT to_regclass('billing.credit_epoch_accounts')::text AS epoch_table,to_regclass('billing.credit_epoch_closures')::text AS closure_table`.execute(
                legacy,
              )
            ).rows[0],
          ).toEqual({ epoch_table: null, closure_table: null });
          expect(
            (
              await sql`SELECT name FROM platform.schema_migrations WHERE name=${migration}`.execute(
                legacy,
              )
            ).rows,
          ).toEqual([]);
        } else {
          const upgrades = await Promise.all(
            Array.from({ length: 20 }, () => runMigrations(old.url, resolve('migrations'))),
          );
          expect(upgrades.flatMap((row) => row.applied)).toEqual([
            migration,
            '000102_m8_support_epoch_closure.sql',
            '000103_m8_support_closure_proof_view.sql',
            '000104_m8_like_original_lives.sql',
            '000105_m8_nakh_original_lives.sql',
            '000106_m8_nakh_references.sql',
          ]);
          expect(
            await legacy
              .selectFrom('billing.credit_epoch_accounts')
              .selectAll()
              .where('user_id', '=', id)
              .execute(),
          ).toEqual([projection]);
          expect(await verifyMigrations(old.url, resolve('migrations/verify'))).toContain(
            migration,
          );
          expect((await runMigrations(old.url, resolve('migrations'))).applied).toEqual([]);
        }
        expect(
          await legacy
            .selectFrom('billing.credit_accounts')
            .selectAll()
            .where('user_id', '=', id)
            .executeTakeFirstOrThrow(),
        ).toEqual(projection);
        expect(
          await legacy
            .selectFrom('billing.credit_transactions')
            .selectAll()
            .where('user_id', '=', id)
            .execute(),
        ).toEqual(ledger);
      } finally {
        await legacy.destroy();
        await old.destroy();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
