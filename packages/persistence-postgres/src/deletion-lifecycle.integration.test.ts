import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
const migration = '000100_m8_deletion_lifecycle_binding.sql';
describe.skipIf(url === undefined)('M8 original deletion lifecycle binding', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_deletion_epoch');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function original(recordId: string, db = database): Promise<Record<string, unknown>> {
    return (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM identity.account_deletion_records WHERE id=${recordId}::uuid`.execute(db)
    ).rows[0]!;
  }
  it('stamps the owning life without exposing new client authority and leaves work replayable', async () => {
    const item = await createDeletionFixture(database);
    const row = await original(item.recordId);
    expect(row).toMatchObject({
      user_id: item.userId,
      product_epoch: 0,
      account_version: 2,
      phase: 'shared_closure',
      reactivation_allowed: false,
    });
    const owner = await database
      .selectFrom('identity.accounts')
      .select(['product_epoch', 'state', 'version'])
      .where('user_id', '=', item.userId)
      .executeTakeFirstOrThrow();
    expect(owner).toEqual({ product_epoch: 0, state: 'deleted', version: 2 });
    // Limit scheduling to this real admission without removing earlier history.
    await sql`UPDATE identity.account_deletion_work SET available_at=clock_timestamp()+interval '1 day'
      WHERE deletion_record_id<>${item.recordId}::uuid`.execute(database);
    const work = new PostgresAccountDeletionWorkStore(database);
    const claims = (
      await Promise.all(
        Array.from({ length: 20 }, () =>
          work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 }),
        ),
      )
    ).flat();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      deletionRecordId: item.recordId,
      userId: item.userId,
      leaseGeneration: 1,
    });
    expect(await original(item.recordId)).toEqual(row);
  });
  it('rejects rebinding and a forged original epoch before uniqueness can admit a second root', async () => {
    const item = await createDeletionFixture(database),
      before = await original(item.recordId);
    await expect(
      sql`UPDATE identity.account_deletion_records SET product_epoch=1 WHERE id=${item.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`INSERT INTO identity.account_deletion_records
      SELECT (jsonb_populate_record(NULL::identity.account_deletion_records,to_jsonb(root)||jsonb_build_object('id',gen_random_uuid(),'product_epoch',1))).*
      FROM identity.account_deletion_records root WHERE id=${item.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '40001' });
    expect(await original(item.recordId)).toEqual(before);
  });
  it('rejects borrowing another owner or an unexplained account version without inserting a root', async () => {
    const item = await createDeletionFixture(database),
      other = await createReportUser(database);
    await expect(
      sql`INSERT INTO identity.account_deletion_records
      SELECT (jsonb_populate_record(NULL::identity.account_deletion_records,to_jsonb(root)||jsonb_build_object('id',gen_random_uuid(),'user_id',${other}::uuid))).*
      FROM identity.account_deletion_records root WHERE id=${item.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      sql`INSERT INTO identity.account_deletion_records
      SELECT (jsonb_populate_record(NULL::identity.account_deletion_records,to_jsonb(root)||jsonb_build_object('id',gen_random_uuid(),'account_version',root.account_version+1))).*
      FROM identity.account_deletion_records root WHERE id=${item.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '40001' });
    expect(
      (
        await sql`SELECT id FROM identity.account_deletion_records WHERE user_id=${other}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
  });
  it('rolls back a pending owner version change at actual commit, including another write in the transaction', async () => {
    const item = await createDeletionFixture(database),
      before = await original(item.recordId);
    const owner = await database
      .selectFrom('identity.accounts')
      .selectAll()
      .where('user_id', '=', item.userId)
      .executeTakeFirstOrThrow();
    await expect(
      database.transaction().execute(async (tx) => {
        await sql`UPDATE identity.accounts SET version=version+1 WHERE user_id=${item.userId}::uuid`.execute(
          tx,
        );
        await sql`UPDATE identity.account_deletion_records SET purge_started_at=clock_timestamp() WHERE id=${item.recordId}::uuid`.execute(
          tx,
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await original(item.recordId)).toEqual(before);
    expect(
      await database
        .selectFrom('identity.accounts')
        .selectAll()
        .where('user_id', '=', item.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual(owner);
    await expect(
      sql`UPDATE identity.accounts SET version=version+1 WHERE user_id=${item.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`UPDATE identity.accounts SET state='guest',product_epoch=1,version=version+1 WHERE user_id=${item.userId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await original(item.recordId)).toEqual(before);
  });
  it.each([false, true])(
    'preserves populated migration 99 and rejects unexplained provenance (corrupt=%s)',
    async (corrupt) => {
      const old = await createIsolatedTestDatabase(url!, 'm8_deletion_upgrade');
      const directory = await mkdtemp(join(tmpdir(), 'nakh-deletion-epoch-'));
      const legacy = createDatabase({
        url: old.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 10000,
      });
      try {
        for (const file of await readdir(resolve('migrations')))
          if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 99)
            await copyFile(join(resolve('migrations'), file), join(directory, file));
        await runMigrations(old.url, directory);
        const item = await createDeletionFixture(legacy),
          before = await original(item.recordId, legacy);
        const owner = await legacy
          .selectFrom('identity.accounts')
          .selectAll()
          .where('user_id', '=', item.userId)
          .executeTakeFirstOrThrow();
        const work = (
          await sql<
            Record<string, unknown>
          >`SELECT * FROM identity.account_deletion_work WHERE deletion_record_id=${item.recordId}::uuid`.execute(
            legacy,
          )
        ).rows[0]!;
        if (corrupt) {
          // Corrupt only this isolated pre-upgrade fixture. Do not use inferred
          // provenance to bless an impossible legacy return or repair its money.
          await sql`ALTER TABLE identity.accounts DISABLE TRIGGER accounts_product_epoch_guard`.execute(
            legacy,
          );
          await sql`UPDATE identity.accounts SET product_epoch=1 WHERE user_id=${item.userId}::uuid`.execute(
            legacy,
          );
          await sql`ALTER TABLE identity.accounts ENABLE TRIGGER accounts_product_epoch_guard`.execute(
            legacy,
          );
          await expect(runMigrations(old.url, resolve('migrations'))).rejects.toMatchObject({
            code: '55000',
          });
          expect(await original(item.recordId, legacy)).toEqual(before);
          expect(
            (
              await sql`SELECT name FROM platform.schema_migrations WHERE name=${migration}`.execute(
                legacy,
              )
            ).rows,
          ).toEqual([]);
          expect(
            (
              await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='identity' AND table_name='account_deletion_records' AND column_name='product_epoch'`.execute(
                legacy,
              )
            ).rows,
          ).toEqual([]);
        } else {
          const upgrades = await Promise.all(
            Array.from({ length: 20 }, () => runMigrations(old.url, resolve('migrations'))),
          );
          expect(upgrades.flatMap((result) => result.applied)).toEqual([
            migration,
            '000101_m8_credit_epoch_partition.sql',
            '000102_m8_support_epoch_closure.sql',
            '000103_m8_support_closure_proof_view.sql',
            '000104_m8_like_original_lives.sql',
            '000105_m8_nakh_original_lives.sql',
          ]);
          expect(await original(item.recordId, legacy)).toEqual({ ...before, product_epoch: 0 });
          expect(
            await legacy
              .selectFrom('identity.accounts')
              .selectAll()
              .where('user_id', '=', item.userId)
              .executeTakeFirstOrThrow(),
          ).toEqual(owner);
          expect(
            (
              await sql<
                Record<string, unknown>
              >`SELECT * FROM identity.account_deletion_work WHERE deletion_record_id=${item.recordId}::uuid`.execute(
                legacy,
              )
            ).rows,
          ).toEqual([work]);
          expect(await verifyMigrations(old.url, resolve('migrations/verify'))).toContain(
            migration,
          );
          expect((await runMigrations(old.url, resolve('migrations'))).applied).toEqual([]);
          expect(
            await new PostgresAccountDeletionWorkStore(legacy).claimDue({
              workerId: randomUUID(),
              limit: 1,
              leaseMs: 120000,
            }),
          ).toHaveLength(1);
        }
      } finally {
        await legacy.destroy();
        await old.destroy();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
