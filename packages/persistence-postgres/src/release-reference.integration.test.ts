import { setTimeout as delay } from 'node:timers/promises';
import { M7_PERMISSIONS } from '@nakh/domain';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { referenceFixtureConfig } from './testing/release-reference-config.js';
import { createReportFixtureAdmin } from './testing/report-fixture.js';
import {
  PostgresReleaseReferenceStore,
  sourceMigrationDigests,
  referenceDigest,
  compareReleaseReference,
  RELEASE_REFERENCE_COLUMNS,
} from './release-reference.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M9 native production reference verification', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  let migrations: Awaited<ReturnType<typeof sourceMigrationDigests>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_reference');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 4,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 5000,
    });
    migrations = await sourceMigrationDigests(resolve('migrations'));
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  const config = referenceFixtureConfig();
  const capture = (): ReturnType<PostgresReleaseReferenceStore['capture']> =>
    new PostgresReleaseReferenceStore(database).capture(config, migrations);
  it('captures every original reference category, exact integer prices and the source migration ledger without writes', async () => {
    const first = await capture(),
      second = await capture();
    expect(referenceDigest(first)).toBe(referenceDigest(second));
    expect(Object.keys(first.native).sort()).toEqual(Object.keys(RELEASE_REFERENCE_COLUMNS).sort());
    expect(first.native['catalog.ui_texts']).toHaveLength(641);
    expect(
      first.native['catalog.ui_texts']?.filter(
        (row) =>
          row !== null &&
          typeof row === 'object' &&
          !Array.isArray(row) &&
          'locale_code' in row &&
          row.locale_code === 'en' &&
          'is_active' in row &&
          row.is_active === true,
      ),
    ).toHaveLength(638);
    expect(first.native['platform.schema_migrations']).toHaveLength(155);
    expect(first.native['administration.admin_roles']).toHaveLength(3);
    expect(first.native['administration.admin_permissions']).toHaveLength(M7_PERMISSIONS.length);
    expect(first.native['billing.credit_packages']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'starter', credit_amount: '10', stars_price: '10' }),
      ]),
    );
    expect(first.pricingRules).toMatchObject({
      nakh: { credits: '2', stars: '2' },
      paidActions: { unlock_chat: { credits: '4', stars: '4' } },
    });
    expect(JSON.stringify(first)).not.toContain('PRIVATE_');
    expect(compareReleaseReference(second, first).matches).toBe(true);
  });
  it('detects committed localization, prompt, price and activation drift without modifying references itself', async () => {
    const changes = [
      [
        sql`UPDATE catalog.ui_texts SET value=value||' test drift' WHERE locale_code='en' AND text_key='preview.ui.card'`,
        sql`UPDATE catalog.ui_texts SET value=left(value,length(value)-11) WHERE locale_code='en' AND text_key='preview.ui.card'`,
      ],
      [
        sql`UPDATE chat.predefined_question_sets SET is_active=NOT is_active,version=version+1,updated_at=clock_timestamp() WHERE code=(SELECT code FROM chat.predefined_question_sets ORDER BY code LIMIT 1)`,
        sql`UPDATE chat.predefined_question_sets SET is_active=NOT is_active,version=version+1,updated_at=clock_timestamp() WHERE code=(SELECT code FROM chat.predefined_question_sets ORDER BY code LIMIT 1)`,
      ],
      [
        sql`UPDATE billing.credit_packages SET stars_price=stars_price+1 WHERE code='starter'`,
        sql`UPDATE billing.credit_packages SET stars_price=stars_price-1 WHERE code='starter'`,
      ],
      [
        sql`UPDATE catalog.cities SET is_active=NOT is_active WHERE id=(SELECT id FROM catalog.cities ORDER BY id LIMIT 1)`,
        sql`UPDATE catalog.cities SET is_active=NOT is_active WHERE id=(SELECT id FROM catalog.cities ORDER BY id LIMIT 1)`,
      ],
    ] as const;
    for (const [change, restore] of changes) {
      const approvedInput = await capture();
      await change.execute(database);
      try {
        expect(compareReleaseReference(await capture(), approvedInput).matches).toBe(false);
      } finally {
        await restore.execute(database);
      }
    }
    expect(referenceDigest(await capture())).toBe(referenceDigest(await capture()));
  });
  it('includes real administrator identity bindings and native role assignment state in private comparison', async () => {
    const before = await capture(),
      admin = await createReportFixtureAdmin(database);
    const afterIdentity = await capture();
    expect(compareReleaseReference(afterIdentity, before).matches).toBe(false);
    expect(afterIdentity.native['administration.admin_users']).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: admin, is_active: true })]),
    );
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: admin,
        role_code: 'super_admin',
        assigned_by_admin_id: admin,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const afterRole = await capture();
    expect(compareReleaseReference(afterRole, afterIdentity).matches).toBe(false);
    expect(afterRole.native['administration.admin_user_roles']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ admin_user_id: admin, role_code: 'super_admin' }),
      ]),
    );
    expect(compareReleaseReference(afterRole, structuredClone(afterRole)).matches).toBe(true);
  });
  it('keeps one consistent snapshot across an observed concurrent price commit and preserves bigints exactly', async () => {
    const before = await capture();
    let release!: () => void, held!: () => void;
    const ready = new Promise<void>((resolve) => {
      held = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = database.transaction().execute(async (tx) => {
      await sql`LOCK TABLE billing.credit_packages IN ACCESS EXCLUSIVE MODE`.execute(tx);
      held();
      await gate;
      await sql`UPDATE billing.credit_packages SET stars_price=9007199254740993 WHERE code='starter'`.execute(
        tx,
      );
    });
    await ready;
    const pending = capture();
    try {
      let observed = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        const result = await sql<{
          waiting: boolean;
        }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ${'%billing%credit_packages%'}) AS waiting`.execute(
          database,
        );
        if (result.rows[0]?.waiting) {
          observed = true;
          break;
        }
        await delay(10);
      }
      expect(observed).toBe(true);
      release();
      await writer;
      expect(compareReleaseReference(await pending, before).matches).toBe(true);
      const after = await capture();
      expect(compareReleaseReference(after, before).matches).toBe(false);
      expect(after.native['billing.credit_packages']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'starter', stars_price: '9007199254740993' }),
        ]),
      );
    } finally {
      release();
      await writer;
      await pending;
      await sql`UPDATE billing.credit_packages SET stars_price=10 WHERE code='starter'`.execute(
        database,
      );
    }
  });
  it('rejects missing, extra and modified migration provenance instead of accepting a partial release', async () => {
    const store = new PostgresReleaseReferenceStore(database);
    await expect(store.capture(config, migrations.slice(1))).rejects.toThrow(
      'Release reference unavailable.',
    );
    const changed = structuredClone(migrations).map((row, index) =>
      index === 0 ? { ...row, sha256: '0'.repeat(64) } : row,
    );
    await expect(store.capture(config, changed)).rejects.toThrow('Release reference unavailable.');
    await expect(
      store.capture(config, [
        ...migrations,
        { name: '999999_unknown.sql', sha256: '1'.repeat(64) },
      ]),
    ).rejects.toThrow('Release reference unavailable.');
    expect((await capture()).native['platform.schema_migrations']).toHaveLength(155);
  });
});
