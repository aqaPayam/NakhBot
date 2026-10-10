import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateDirectNakhCommand } from '@nakh/contracts';
import type { CreateDirectNakhWrite } from '@nakh/application';
import { createDatabase, type NakhDatabase, type NakhReferenceAnchorTable } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { PostgresDirectNakhStore } from './direct-nakh-store.js';
import { PostgresDeliveredNakhStore } from './delivered-nakh-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { PostgresAccountDeletionStore } from './account-deletion-store.js';
import { createReportUser } from './testing/report-fixture.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 original funded Nakh references', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let survivor: string, owner: string, historicalId: string, originalFacts: unknown;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_nakh_reference');
    const directory = await mkdtemp(join(tmpdir(), 'm8-nakh105-'));
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 105)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(isolated.url, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 10000,
    });
    const scene = await prepared();
    owner = scene.sender;
    survivor = scene.receiver;
    historicalId = (await scene.store.createDirect(scene.write)).nakhId;
    const key = randomBytes(32),
      deletion = new PostgresAccountDeletionStore(database, {
        activeKeyId: 'm8-nakh-reference',
        keys: new Map([['m8-nakh-reference', key]]),
      });
    try {
      const account = await database
        .selectFrom('identity.accounts')
        .select('version')
        .where('user_id', '=', owner)
        .executeTakeFirstOrThrow();
      const proof = await deletion.prepare({
        actor: { kind: 'user', userId: owner },
        requestId: randomUUID(),
        expectedAccountVersion: account.version,
      });
      const id = randomUUID();
      await deletion.request({
        commandId: id,
        commandType: 'account.delete',
        schemaVersion: 1,
        actor: { kind: 'user', userId: owner },
        requestId: randomUUID(),
        idempotencyKey: `m8-nakh-delete:${id}`,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          expectedAccountVersion: account.version,
          confirmationToken: proof.confirmationToken,
        },
      });
    } finally {
      key.fill(0);
    }
    originalFacts = await facts();
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  function facts(): Promise<unknown[]> {
    return Promise.all([
      database.selectFrom('nakh.nakhes').selectAll().orderBy('id').execute(),
      database.selectFrom('nakh.nakh_flows').selectAll().orderBy('id').execute(),
      database.selectFrom('nakh.nakh_status_history').selectAll().orderBy('id').execute(),
      database.selectFrom('billing.credit_transactions').selectAll().orderBy('id').execute(),
      database.selectFrom('billing.credit_accounts').selectAll().orderBy('user_id').execute(),
      database.selectFrom('platform.idempotency_records').selectAll().orderBy('id').execute(),
      database.selectFrom('platform.audit_logs').selectAll().orderBy('id').execute(),
      database.selectFrom('platform.outbox_events').selectAll().orderBy('id').execute(),
      database.selectFrom('notification.notifications').selectAll().orderBy('id').execute(),
    ]);
  }
  async function anchor(id: string): Promise<NakhReferenceAnchorTable> {
    return database
      .selectFrom('nakh.nakh_reference_anchors')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }
  async function prepared(): Promise<{
    sender: string;
    receiver: string;
    write: CreateDirectNakhWrite;
    store: PostgresDirectNakhStore;
  }> {
    const sender = await createReportUser(database, true),
      receiver = await createReportUser(database, true),
      at = new Date();
    for (const userId of [sender, receiver]) {
      await database
        .insertInto('identity.user_settings')
        .values({ user_id: userId, created_at: at, updated_at: at })
        .execute();
      await database
        .insertInto('billing.credit_accounts')
        .values({ user_id: userId, created_at: at, updated_at: at })
        .execute();
      await database
        .insertInto('notification.notification_preferences')
        .values({ user_id: userId, created_at: at, updated_at: at })
        .execute();
    }
    await new PostgresCreditLedgerStore(database).append({
      transactionId: randomUUID(),
      userId: sender,
      transactionType: 'admin_adjustment',
      amount: 4n,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    const command: CreateDirectNakhCommand = {
      commandType: 'nakh.create-direct',
      schemaVersion: 1,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      actor: { kind: 'user', userId: sender },
      occurredAt: at.toISOString(),
      locale: 'en',
      data: { targetUserId: receiver, text: 'Original ordinary private Nakh text' },
    };
    const write = {
      command,
      flowId: randomUUID(),
      nakhId: randomUUID(),
      creditTransactionId: randomUUID(),
      historyId: randomUUID(),
      flowEventId: randomUUID(),
      deliveredEventId: randomUUID(),
    };
    return { sender, receiver, write, store: new PostgresDirectNakhStore(database) };
  }
  it('upgrades once under twenty retries without changing deleted-owner sources or financial facts', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(results.flatMap((result) => result.applied)).toEqual(['000106_m8_nakh_references.sql']);
    expect(await facts()).toEqual(originalFacts);
    const source = await database
      .selectFrom('nakh.nakhes')
      .selectAll()
      .where('id', '=', historicalId)
      .executeTakeFirstOrThrow();
    expect(await anchor(historicalId)).toEqual({
      id: historicalId,
      nakh_flow_id: source.nakh_flow_id,
      sender_user_id: owner,
      receiver_user_id: survivor,
      sender_product_epoch: 0,
      receiver_product_epoch: 0,
    });
    expect(Object.keys(await anchor(historicalId)).sort()).toEqual([
      'id',
      'nakh_flow_id',
      'receiver_product_epoch',
      'receiver_user_id',
      'sender_product_epoch',
      'sender_user_id',
    ]);
    await expect(
      new PostgresDeliveredNakhStore(database).readDetail(survivor, historicalId),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000106_m8_nakh_references.sql',
    );
    expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([]);
    const catalog = await readDeletionCatalog(database);
    expect(catalog.tables).toHaveLength(132);
    expect(catalog.tables.reduce((count, table) => count + table.columns.length, 0)).toBe(1208);
    expect(catalog.foreignKeys).toHaveLength(244);
    assertDeletionCatalogCoverage(catalog);
  });
  it('rejects orphan, reassigned and borrowed-life anchors and denies retained identity mutation', async () => {
    const original = await anchor(historicalId);
    await expect(
      database
        .insertInto('nakh.nakh_reference_anchors')
        .values({ ...original, id: randomUUID() })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    for (const patch of [
      { nakh_flow_id: randomUUID() },
      { sender_user_id: survivor },
      { sender_product_epoch: 1 },
      { receiver_product_epoch: 1 },
    ])
      await expect(
        database
          .insertInto('nakh.nakh_reference_anchors')
          .values({ ...original, ...patch })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database
        .updateTable('nakh.nakh_reference_anchors')
        .set({ sender_product_epoch: 1 })
        .where('id', '=', historicalId)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database.deleteFrom('nakh.nakh_reference_anchors').where('id', '=', historicalId).execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database.deleteFrom('nakh.nakhes').where('id', '=', historicalId).execute(),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await anchor(historicalId)).toEqual(original);
    expect(await facts()).toEqual(originalFacts);
  });
  it('creates one exact reference and one spend for twenty actual command retries', async () => {
    const scene = await prepared();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => scene.store.createDirect(scene.write)),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(19);
    expect(await anchor(scene.write.nakhId)).toEqual({
      id: scene.write.nakhId,
      nakh_flow_id: scene.write.flowId,
      sender_user_id: scene.sender,
      receiver_user_id: scene.receiver,
      sender_product_epoch: 0,
      receiver_product_epoch: 0,
    });
    const spends = await database
      .selectFrom('billing.credit_transactions')
      .select(['id', 'amount'])
      .where('nakh_id', '=', scene.write.nakhId)
      .execute();
    expect(spends).toEqual([{ id: scene.write.creditTransactionId, amount: '-2' }]);
    expect(
      (
        await database
          .selectFrom('billing.credit_accounts')
          .select('balance')
          .where('user_id', '=', scene.sender)
          .executeTakeFirstOrThrow()
      ).balance,
    ).toBe('2');
    const original = await facts();
    // Transaction-local corruption proves retired identity denial only. The
    // expected native failure rolls back the source removal and all FK facts.
    await expect(
      database.transaction().execute(async (tx) => {
        const source = await tx
          .selectFrom('nakh.nakhes')
          .selectAll()
          .where('id', '=', scene.write.nakhId)
          .executeTakeFirstOrThrow();
        await sql`SET LOCAL session_replication_role=replica`.execute(tx);
        await tx.deleteFrom('nakh.nakhes').where('id', '=', source.id).execute();
        await sql`SET LOCAL session_replication_role=origin`.execute(tx);
        await tx.insertInto('nakh.nakhes').values(source).execute();
      }),
    ).rejects.toMatchObject({
      code: '23514',
      where: expect.stringContaining('reject_original_identity_reuse()') as unknown,
    });
    expect(await facts()).toEqual(original);
  });
  it('rolls back the actual command when its mandatory reference is suppressed and permits the same retry', async () => {
    const scene = await prepared(),
      original = await facts();
    await sql`CREATE FUNCTION nakh.m8_suppress_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER zz_m8_suppress_reference BEFORE INSERT ON nakh.nakh_reference_anchors FOR EACH ROW EXECUTE FUNCTION nakh.m8_suppress_reference()`.execute(
      database,
    );
    try {
      await expect(scene.store.createDirect(scene.write)).rejects.toMatchObject({
        code: '23514',
        where: expect.stringContaining('require_original_reference()') as unknown,
      });
      expect(await facts()).toEqual(original);
      expect(
        await database
          .selectFrom('platform.idempotency_records')
          .select('idempotency_key')
          .where('actor_user_id', '=', scene.sender)
          .where('idempotency_key', '=', scene.write.command.idempotencyKey)
          .execute(),
      ).toEqual([]);
      expect(
        await database
          .selectFrom('nakh.nakh_reference_anchors')
          .select('id')
          .where('id', '=', scene.write.nakhId)
          .execute(),
      ).toEqual([]);
    } finally {
      await sql`DROP TRIGGER zz_m8_suppress_reference ON nakh.nakh_reference_anchors`.execute(
        database,
      );
      await sql`DROP FUNCTION nakh.m8_suppress_reference()`.execute(database);
    }
    expect((await scene.store.createDirect(scene.write)).replayed).toBe(false);
    expect((await scene.store.createDirect(scene.write)).replayed).toBe(true);
    expect((await anchor(scene.write.nakhId)).sender_user_id).toBe(scene.sender);
  });
});
