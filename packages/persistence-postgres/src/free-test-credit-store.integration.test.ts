import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FreeTestCreditWrite, UserSessionActor } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresLaunchCohortControl } from './launch-cohort-store.js';
import { PostgresFreeTestCreditModeControl } from './free-test-credit-mode.js';
import { PostgresFreeTestCreditStore } from './free-test-credit-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { RUNTIME_DATABASE_SCHEMAS } from './runtime-database-policy.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('native repeatable free test credits', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  let owner: UserSessionActor, other: string, store: PostgresFreeTestCreditStore;
  let policyVersion = 0,
    modeVersion = 0;
  let mode: PostgresFreeTestCreditModeControl, cohort: PostgresLaunchCohortControl;
  let runtimeDatabase: NakhDatabase;
  const role = 'free_credit_probe_' + randomUUID().replaceAll('-', '');
  let roleCreated = false;
  const audience = {
    sourceSha: 'a'.repeat(40),
    environment: 'staging' as const,
    telegramBotId: '12345',
  };
  const write = (): FreeTestCreditWrite => ({
    transactionId: randomUUID(),
    eventId: randomUUID(),
    command: {
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'billing.grant-free-test-credits',
      schemaVersion: 1,
      actor: { kind: 'user', userId: owner.userId },
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {},
    },
  });
  const balance = async (): Promise<string> => (await store.state()).balance;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_free_test_credits');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 20000,
    });
    mode = new PostgresFreeTestCreditModeControl(database, randomUUID());
    cohort = new PostgresLaunchCohortControl(database, { operatorId: randomUUID() });
    const password = randomUUID();
    await sql`CREATE ROLE ${sql.id(role)} LOGIN PASSWORD ${sql.lit(password)}`.execute(database);
    roleCreated = true;
    for (const schema of RUNTIME_DATABASE_SCHEMAS) {
      await sql`GRANT USAGE ON SCHEMA ${sql.id(schema)} TO ${sql.id(role)}`.execute(database);
      await sql`GRANT SELECT ON ALL TABLES IN SCHEMA ${sql.id(schema)} TO ${sql.id(role)}`.execute(
        database,
      );
    }
    await sql`GRANT INSERT ON billing.credit_transactions,billing.credit_epoch_accounts,platform.audit_logs,platform.outbox_events TO ${sql.id(role)}`.execute(
      database,
    );
    await sql`GRANT UPDATE ON billing.credit_accounts,billing.credit_epoch_accounts,identity.users,identity.accounts TO ${sql.id(role)}`.execute(
      database,
    );
    const runtimeUrl = new URL(isolated.url);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtimeDatabase = createDatabase({
      url: runtimeUrl.toString(),
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 20000,
    });
  });
  beforeEach(async () => {
    const userId = await createReportUser(database, true);
    other = await createReportUser(database, true);
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: userId, created_at: new Date(), updated_at: new Date() })
      .execute();
    const session = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch: 0 },
      randomUUID(),
    );
    owner = { kind: 'user', userId, productEpoch: 0, sessionGrantId: session!.id };
    const expiresAt = new Date(Date.now() + 3600000).toISOString(),
      policyId = randomUUID();
    policyVersion = (
      await cohort.apply({
        ...audience,
        requestId: policyId,
        expectedVersion: policyVersion,
        mode: 'cohort',
        expiresAt,
        reviewDigest: 'b'.repeat(64),
        members: [{ userId, productEpoch: 0 }],
      })
    ).version;
    modeVersion = (
      await mode.apply({
        ...audience,
        requestId: randomUUID(),
        expectedVersion: modeVersion,
        enabled: true,
        expiresAt,
        cohortPolicyId: policyId,
      })
    ).version;
    store = new PostgresFreeTestCreditStore(database, owner, audience);
  });
  afterAll(async () => {
    await runtimeDatabase?.destroy();
    await database?.destroy();
    await isolated?.destroy();
    if (roleCreated) {
      const root = createDatabase({
        url: url!,
        poolMax: 1,
        statementTimeoutMs: 10000,
        lockTimeoutMs: 10000,
      });
      try {
        await sql`DROP ROLE ${sql.id(role)}`.execute(root);
      } finally {
        await root.destroy();
      }
    }
  });
  async function close(): Promise<void> {
    modeVersion = (
      await mode.apply({
        ...audience,
        requestId: randomUUID(),
        expectedVersion: modeVersion,
        enabled: false,
        cohortPolicyId: null,
        expiresAt: null,
      })
    ).version;
  }
  it('converges twenty concurrent retries, then accepts a new refill with one event per grant', async () => {
    const first = write(),
      results = await Promise.all(
        Array.from({ length: 20 }, () =>
          store.grant({ ...first, transactionId: randomUUID(), eventId: randomUUID() }),
        ),
      );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await balance()).toBe('100');
    await store.grant(write());
    expect(await balance()).toBe('200');
    const credits = await database
      .selectFrom('billing.credit_transactions')
      .select('id')
      .where('user_id', '=', owner.userId)
      .execute();
    expect(credits).toHaveLength(2);
    for (const credit of credits)
      expect(
        (
          await sql<{
            valid: boolean;
          }>`SELECT billing.free_test_topup_proof(${credit.id}::uuid) AS valid`.execute(database)
        ).rows[0]?.valid,
      ).toBe(true);
    const events = await database
      .selectFrom('platform.outbox_events')
      .select('id')
      .where('aggregate_id', '=', owner.userId)
      .where('event_type', '=', 'billing.credit-increased.v1')
      .execute();
    expect(events).toHaveLength(2);
    expect(
      (
        await sql<{
          blocked: boolean;
        }>`SELECT platform.deletion_operational_blocker(${owner.userId}::uuid) AS blocked`.execute(
          database,
        )
      ).rows[0]?.blocked,
    ).toBe(false);
    expect(await database.selectFrom('billing.payment_records').select('id').execute()).toEqual([]);
  });
  it('serializes independent refills without losing balance updates', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.grant(write())));
    expect(results.every((r) => !r.replayed)).toBe(true);
    expect(await balance()).toBe('800');
    expect(results.map((r) => Number(r.balanceAfter)).sort((a, b) => a - b)).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800,
    ]);
  });
  it('checks current authority before replay and keeps historical proof valid after closing', async () => {
    const input = write(),
      result = await store.grant(input);
    await close();
    await expect(store.grant(input)).rejects.toMatchObject({ status: 403 });
    await expect(store.grant(write())).rejects.toMatchObject({ status: 403 });
    expect(await balance()).toBe('100');
    expect(
      (
        await sql<{
          valid: boolean;
        }>`SELECT billing.free_test_topup_proof(${result.transactionId}::uuid) AS valid`.execute(
          database,
        )
      ).rows[0]?.valid,
    ).toBe(true);
  });
  it('rejects cross-user commands, an incorrect source and a revoked original session', async () => {
    const input = write();
    await expect(
      store.grant({
        ...input,
        command: { ...input.command, actor: { kind: 'user', userId: other } },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      new PostgresFreeTestCreditStore(database, owner, {
        ...audience,
        sourceSha: 'c'.repeat(40),
      }).grant(write()),
    ).rejects.toMatchObject({ status: 403 });
    await new PostgresUserSessionStore(database).revoke(owner, owner.sessionGrantId, randomUUID());
    await expect(store.grant(write())).rejects.toMatchObject({ status: 401 });
  });
  it('denies restricted and banned accounts and bounds rapid new grants while allowing retries', async () => {
    const inputs = Array.from({ length: 10 }, write);
    for (const input of inputs) await store.grant(input);
    expect((await store.grant(inputs[0]!)).replayed).toBe(true);
    await expect(store.grant(write())).rejects.toMatchObject({ status: 429 });
    for (const state of ['restricted', 'banned'] as const) {
      await database
        .updateTable('identity.accounts')
        .set({ state, version: sql`version+1` })
        .where('user_id', '=', owner.userId)
        .execute();
      await expect(store.grant(write())).rejects.toMatchObject({ status: 403 });
    }
  });
  it('does not accept a direct ledger credit without audit and outbox proof', async () => {
    const id = randomUUID();
    await expect(
      database.transaction().execute(async (tx) => {
        await tx
          .insertInto('billing.credit_transactions')
          .values({
            id,
            credit_account_id: owner.userId,
            user_id: owner.userId,
            product_epoch: 0,
            account_version: 2,
            transaction_type: 'free_test_topup',
            amount: '100',
            balance_before: '0',
            balance_after: '100',
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
          .set({ balance: '100', version: 2 })
          .where('user_id', '=', owner.userId)
          .execute();
      }),
    ).rejects.toThrow();
    expect(await balance()).toBe('0');
  });
  it('fences mode closure against a racing grant with no partial ledger effect', async () => {
    const [grant] = await Promise.allSettled([store.grant(write()), close()]);
    const actual = await balance();
    expect(actual).toBe(grant.status === 'fulfilled' ? '100' : '0');
    expect((await store.state()).enabled).toBe(false);
    await expect(store.grant(write())).rejects.toMatchObject({ status: 403 });
  });
  it('allows a restricted database login to grant within authority but never to create mode authority', async () => {
    const runtimeStore = new PostgresFreeTestCreditStore(runtimeDatabase, owner, audience);
    await runtimeStore.grant(write());
    expect(await balance()).toBe('100');
    await expect(
      new PostgresFreeTestCreditModeControl(runtimeDatabase, randomUUID()).apply({
        ...audience,
        requestId: randomUUID(),
        expectedVersion: modeVersion,
        enabled: false,
        cohortPolicyId: null,
        expiresAt: null,
      }),
    ).rejects.toThrow();
    const row = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('event_type', '=', 'platform.free-credit-test-mode-applied.v1')
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    await expect(
      runtimeDatabase
        .insertInto('platform.audit_logs')
        .values({ ...row, id: randomUUID() } as typeof row)
        .execute(),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await store.state()).enabled).toBe(true);
  });
  it('rejects an extra audit that tries to borrow an earlier credit proof', async () => {
    const result = await store.grant(write());
    const original = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('id', '=', result.transactionId)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .insertInto('platform.audit_logs')
        .values({ ...original, id: randomUUID() })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await balance()).toBe('100');
  });
  it('upgrades populated schema 164 without changing existing ledger rows or migration receipts', async () => {
    const old = await createIsolatedTestDatabase(url!, 'nakh_free_credit_upgrade'),
      path = await mkdtemp(join(tmpdir(), 'nakh-credit-upgrade-'));
    let legacy: NakhDatabase | undefined;
    try {
      for (const name of await readdir(resolve('migrations')))
        if (/^\d+.*\.sql$/u.test(name) && name < '000165_m9_free_test_credits.sql')
          await copyFile(resolve('migrations', name), join(path, name));
      await runMigrations(old.url, path);
      legacy = createDatabase({
        url: old.url,
        poolMax: 1,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 10000,
      });
      const user = await createReportUser(legacy),
        now = new Date();
      await legacy
        .insertInto('billing.credit_accounts')
        .values({ user_id: user, created_at: now, updated_at: now })
        .execute();
      await new PostgresCreditLedgerStore(legacy).append({
        transactionId: randomUUID(),
        userId: user,
        transactionType: 'admin_adjustment',
        amount: 7n,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      const ledger = await legacy.selectFrom('billing.credit_transactions').selectAll().execute();
      const before = await legacy
        .selectFrom('platform.schema_migrations')
        .selectAll()
        .orderBy('name')
        .execute();
      expect(before).toHaveLength(164);
      expect((await runMigrations(old.url, resolve('migrations'))).applied).toEqual([
        '000165_m9_free_test_credits.sql',
        '000166_m9_profile_settings_menus.sql',
      ]);
      expect(await legacy.selectFrom('billing.credit_transactions').selectAll().execute()).toEqual(
        ledger,
      );
      expect(
        await legacy
          .selectFrom('platform.schema_migrations')
          .selectAll()
          .where('name', '<', '000165_m9_free_test_credits.sql')
          .orderBy('name')
          .execute(),
      ).toEqual(before);
      await verifyMigrations(old.url, resolve('migrations/verify'));
      expect((await runMigrations(old.url, resolve('migrations'))).applied).toEqual([]);
    } finally {
      await legacy?.destroy();
      await old.destroy();
      await rm(path, { recursive: true, force: true });
    }
  });
});
