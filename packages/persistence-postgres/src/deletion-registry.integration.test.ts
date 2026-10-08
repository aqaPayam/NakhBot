import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportLike, createReportUser } from './testing/report-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import {
  DELETION_REGISTRY,
  assertDeletionCatalogCoverage,
  readDeletionCatalog,
  PostgresDeletionRegistryStore,
  type DeletionRegistryObservation,
} from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 native deletion registry', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_m8_registry');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,
      available_at=clock_timestamp()+interval '1 day'`.execute(database);
  });
  it('covers every real table, column and foreign-key action with qualified names', async () => {
    const actual = await readDeletionCatalog(database);
    expect(actual.tables).toHaveLength(123);
    expect(actual.tables.reduce((count, table) => count + table.columns.length, 0)).toBe(1111);
    expect(actual.foreignKeys).toHaveLength(223);
    expect(() => assertDeletionCatalogCoverage(actual)).not.toThrow();
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL search_path=nakh,public`.execute(tx);
      assertDeletionCatalogCoverage(await readDeletionCatalog(tx));
      const restored = (
        await sql<{ path: string }>`SELECT current_setting('search_path') AS path`.execute(tx)
      ).rows[0]!.path;
      expect(restored).toBe('nakh, public');
    });
  });
  it('executes every linked selector in bounded fenced observations without returning private data', async () => {
    const item = await createDeletionFixture(database);
    const work = new PostgresAccountDeletionWorkStore(database);
    const lease = (await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 }))[0]!;
    expect(lease.userId).toBe(item.userId);
    const store = new PostgresDeletionRegistryStore(database);
    for (let index = 0; index < DELETION_REGISTRY.length; index++) {
      const observation = await store.observe(lease, index);
      expect(Object.keys(observation).sort()).toEqual([
        'action',
        'classification',
        'hasMore',
        'present',
        'resourceIndex',
        'scope',
      ]);
      expect(observation.resourceIndex).toBe(index);
      expect(observation.hasMore).toBe(index < DELETION_REGISTRY.length - 1);
      expect(observation.present === null || typeof observation.present === 'boolean').toBe(true);
      expect(JSON.stringify(observation)).not.toContain(item.userId);
      expect(JSON.stringify(observation)).not.toContain(item.recordId);
    }
    expect(
      (
        await database
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', item.userId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('deleted');
    expect(
      (
        await sql<{
          phase: string;
        }>`SELECT phase FROM identity.account_deletion_records WHERE id=${item.recordId}::uuid`.execute(
          database,
        )
      ).rows[0]!.phase,
    ).toBe('shared_closure');
  });
  it('distinguishes own data and both shared pair directions from unrelated participants', async () => {
    const peer = await createReportUser(database, true),
      unrelated = await createReportUser(database, true);
    await createReportLike(database, peer, unrelated);
    let relatedLike = '';
    const item = await createDeletionFixture(database, async (userId) => {
      relatedLike = await createReportLike(database, userId, peer);
    });
    const lease = (
      await new PostgresAccountDeletionWorkStore(database).claimDue({
        workerId: randomUUID(),
        leaseMs: 120000,
        limit: 1,
      })
    )[0]!;
    const store = new PostgresDeletionRegistryStore(database);
    const observe = (table: string): Promise<DeletionRegistryObservation> =>
      store.observe(
        lease,
        DELETION_REGISTRY.findIndex((entry) => entry.table === table),
      );
    expect((await observe('interaction.likes')).present).toBe(true);
    expect((await observe('profile.profiles')).present).toBe(false);
    expect((await observe('identity.user_settings')).present).toBe(true);
    await database
      .deleteFrom('identity.user_settings')
      .where('user_id', '=', item.userId)
      .execute();
    expect((await observe('identity.user_settings')).present).toBe(false);
    await database.deleteFrom('interaction.likes').where('id', '=', relatedLike).execute();
    expect((await observe('interaction.likes')).present).toBe(false);
    await createReportLike(database, peer, item.userId);
    expect((await observe('interaction.likes')).present).toBe(true);
    expect(
      await database
        .selectFrom('profile.profiles')
        .select('id')
        .where('user_id', 'in', [peer, unrelated])
        .execute(),
    ).toHaveLength(2);
  });
  it('rejects unknown resources, forged subjects and stale generations before observing rows', async () => {
    const item = await createDeletionFixture(database),
      work = new PostgresAccountDeletionWorkStore(database);
    const lease = (await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 }))[0]!,
      store = new PostgresDeletionRegistryStore(database);
    const index = DELETION_REGISTRY.findIndex((entry) => entry.table === 'identity.users');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.observe(lease, index)),
    );
    expect(results.every((result) => result.present === true)).toBe(true);
    for (const resource of [-1, DELETION_REGISTRY.length, NaN, 0.1])
      await expect(store.observe(lease, resource)).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.observe({ ...lease, userId: randomUUID() }, index)).rejects.toMatchObject({
      code: 'conflict',
    });
    await work.release(lease);
    await expect(store.observe(lease, index)).rejects.toMatchObject({ code: 'conflict' });
    expect(
      (
        await database
          .selectFrom('identity.users')
          .select('id')
          .where('id', '=', item.userId)
          .execute()
      ).length,
    ).toBe(1);
  });
  it.each(['table', 'column', 'dependency'] as const)(
    'blocks observation on unclassified %s drift',
    async (kind) => {
      await createDeletionFixture(database);
      const lease = (
        await new PostgresAccountDeletionWorkStore(database).claimDue({
          workerId: randomUUID(),
          leaseMs: 120000,
          limit: 1,
        })
      )[0]!;
      const store = new PostgresDeletionRegistryStore(database);
      if (kind === 'table')
        await sql`CREATE TABLE profile.m8_unclassified(id uuid PRIMARY KEY)`.execute(database);
      else if (kind === 'column')
        await sql`ALTER TABLE identity.user_settings ADD COLUMN m8_unclassified text`.execute(
          database,
        );
      else
        await sql`ALTER TABLE identity.user_settings ADD CONSTRAINT m8_unclassified_fk FOREIGN KEY(user_id) REFERENCES identity.accounts(user_id)`.execute(
          database,
        );
      try {
        await expect(store.observe(lease, 0)).rejects.toMatchObject({ code: 'conflict' });
      } finally {
        if (kind === 'table') await sql`DROP TABLE profile.m8_unclassified`.execute(database);
        else if (kind === 'column')
          await sql`ALTER TABLE identity.user_settings DROP COLUMN m8_unclassified`.execute(
            database,
          );
        else
          await sql`ALTER TABLE identity.user_settings DROP CONSTRAINT m8_unclassified_fk`.execute(
            database,
          );
      }
      expect(
        (
          await store.observe(
            lease,
            DELETION_REGISTRY.findIndex((entry) => entry.table === 'identity.users'),
          )
        ).present,
      ).toBe(true);
    },
  );
});
