import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SettlePendingNakhesHandler, type CreatePendingNakhWrite } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';
import { PostgresPendingNakhSettlementStore } from './pending-nakh-settlement-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresNakhReconciliationStore } from './nakh-reconciliation-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 original pending Nakh references', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let original: unknown;
  const historicalIds: string[] = [];
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_pending_reference');
    const temporaryRoot = resolve(tmpdir());
    const directory = resolve(await mkdtemp(join(temporaryRoot, 'm8-pending112-')));
    if (!directory.startsWith(`${temporaryRoot}${sep}`))
      throw new Error('Unsafe migration temporary path');
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 111)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(isolated.url, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    for (const paid of [false, true]) {
      const receiver = await activeUser();
      await createDeletionFixture(database, async (sender) => {
        const profile = await database
          .selectFrom('profile.profiles')
          .selectAll()
          .where('user_id', '=', receiver)
          .executeTakeFirstOrThrow();
        await database
          .insertInto('profile.profiles')
          .values({ ...profile, id: randomUUID(), user_id: sender })
          .execute();
        await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp()
          WHERE user_id=${sender}::uuid`.execute(database);
        const created = await new PostgresPendingNakhStore(database).createPending(
          write(sender, receiver),
        );
        historicalIds.push(created.pendingNakhId);
        if (paid) {
          const credit = await new PostgresCreditLedgerStore(database).append({
            transactionId: randomUUID(),
            userId: sender,
            transactionType: 'admin_adjustment',
            amount: 2n,
            idempotencyKey: randomUUID(),
            correlationId: randomUUID(),
          });
          await new SettlePendingNakhesHandler(new PostgresPendingNakhSettlementStore(database), {
            uuid: randomUUID,
          }).execute({
            senderUserId: sender,
            triggerCreditTransactionId: credit.transactionId,
            causationId: randomUUID(),
          });
          expect(
            await database
              .selectFrom('nakh.pending_nakhes')
              .select('status')
              .where('id', '=', created.pendingNakhId)
              .executeTakeFirstOrThrow(),
          ).toEqual({ status: 'paid_and_sent' });
        }
      });
    }
    original = await facts();
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function activeUser(target: NakhDatabase = database): Promise<string> {
    const userId = await createReportUser(target, true),
      at = new Date();
    for (const table of [
      'identity.user_settings',
      'billing.credit_accounts',
      'notification.notification_preferences',
    ] as const)
      await target
        .insertInto(table)
        .values({ user_id: userId, created_at: at, updated_at: at })
        .execute();
    return userId;
  }
  function write(sender: string, receiver: string): CreatePendingNakhWrite {
    return {
      command: {
        commandId: randomUUID(),
        commandType: 'nakh.create-pending',
        schemaVersion: 1,
        actor: { kind: 'user', userId: sender },
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          targetUserId: receiver,
          text: 'Private pending body must not enter reference',
          autoSettleAuthorized: true,
        },
      },
      flowId: randomUUID(),
      pendingNakhId: randomUUID(),
      pendingPaymentId: randomUUID(),
      flowEventId: randomUUID(),
      pendingEventId: randomUUID(),
    };
  }
  async function facts(target: NakhDatabase = database): Promise<unknown> {
    return (
      await sql<{ facts: unknown }>`SELECT jsonb_build_object(
      'pending',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.pending_nakhes row),
      'flows',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.nakh_flows row),
      'delivered',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.nakhes row),
      'intents',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.pending_payments row),
      'credits',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.credit_transactions row),
      'accounts',(SELECT jsonb_agg(to_jsonb(row) ORDER BY user_id) FROM identity.accounts row),
      'roots',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM identity.account_deletion_records row),
      'preview',(SELECT jsonb_agg(to_jsonb(row) ORDER BY user_id) FROM identity.guest_preview_counters row),
      'counters',(SELECT jsonb_agg(to_jsonb(row) ORDER BY user_id) FROM platform.user_counters row),
      'audit',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM platform.audit_logs row),
      'events',(SELECT jsonb_agg(jsonb_build_object('deletion_cancellation_audit_id',NULL)||to_jsonb(row) ORDER BY id) FROM platform.outbox_events row)
    ) AS facts`.execute(target)
    ).rows[0]!.facts;
  }
  async function valid(id: string): Promise<boolean> {
    return (
      await sql<{
        valid: boolean;
      }>`SELECT nakh.original_pending_reference_valid(${id}::uuid) AS valid`.execute(database)
    ).rows[0]!.valid;
  }
  it('upgrades populated unpaid and credit-paid deleted lives under twenty migration races without rewriting facts', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(results.flatMap((result) => result.applied)).toEqual([
      '000112_m8_pending_nakh_references.sql',
      '000113_m8_pending_funding_binding.sql',
      '000114_m8_paid_pending_archival.sql',
      '000115_m8_terminal_pending_archival.sql',
      '000116_m8_flow_references.sql',
      '000117_m8_flow_archival.sql',
      '000118_m8_referenced_like_archival.sql',
      '000119_m8_unlock_original_references.sql',
      '000120_m8_owned_unlock_archival.sql',
      '000121_m8_match_original_lives.sql',
      '000122_m8_pair_archival.sql',
      '000123_m8_notification_references.sql',
      '000124_m8_notification_archival.sql',
      '000125_m8_owned_transport_batches.sql',
      '000126_m8_operational_outbox_cancellation.sql',
      '000127_m8_product_checkpoint.sql',
      '000128_m8_product_fence_lock_order.sql',
      '000129_m8_account_media_provider_work.sql',
      '000130_m8_media_checkpoint.sql',
      '000131_m8_private_photo_parallel_read.sql',
    ]);
    expect(await facts()).toEqual(original);
    for (const id of historicalIds) expect(await valid(id)).toBe(true);
    expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([]);
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000112_m8_pending_nakh_references.sql',
    );
    const catalog = await readDeletionCatalog(database);
    expect(catalog.tables).toHaveLength(148);
    expect(catalog.tables.reduce((count, table) => count + table.columns.length, 0)).toBe(1371);
    expect(catalog.foreignKeys).toHaveLength(294);
    assertDeletionCatalogCoverage(catalog);
  });
  it.each(['target', 'payer-life'] as const)(
    'refuses an unsupported legacy %s without inventing migration progress',
    async (fault) => {
      const legacy = await createIsolatedTestDatabase(url!, 'm8_pending_bad_legacy');
      const temporaryRoot = resolve(tmpdir()),
        directory = resolve(await mkdtemp(join(temporaryRoot, 'm8-pending-bad112-')));
      if (!directory.startsWith(`${temporaryRoot}${sep}`))
        throw new Error('Unsafe migration temporary path');
      let target: NakhDatabase | undefined;
      try {
        for (const file of await readdir(resolve('migrations')))
          if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 111)
            await copyFile(join(resolve('migrations'), file), join(directory, file));
        await runMigrations(legacy.url, directory);
        target = createDatabase({
          url: legacy.url,
          poolMax: 2,
          statementTimeoutMs: 30000,
          lockTimeoutMs: 15000,
        });
        const sender = await activeUser(target),
          receiver = await activeUser(target);
        const pending = await new PostgresPendingNakhStore(target).createPending(
          write(sender, receiver),
        );
        await target.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            await connection
              .updateTable('billing.pending_payments')
              .set(fault === 'target' ? { target_id: randomUUID() } : { product_epoch: 1 })
              .where('id', '=', pending.fundingIntentId)
              .execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
        const before = await facts(target);
        await expect(runMigrations(legacy.url, resolve('migrations'))).rejects.toMatchObject({
          code: '23514',
        });
        expect(await facts(target)).toEqual(before);
        expect(
          (
            await sql<{ reference: string | null; applied: number }>`SELECT
        to_regclass('nakh.pending_nakh_reference_anchors')::text AS reference,
        (SELECT count(*)::integer FROM platform.schema_migrations WHERE name='000112_m8_pending_nakh_references.sql') AS applied`.execute(
              target,
            )
          ).rows,
        ).toEqual([{ reference: null, applied: 0 }]);
      } finally {
        await rm(directory, { recursive: true, force: true });
        await target?.destroy();
        await legacy.destroy();
      }
    },
  );
  it('creates one minimal reference during twenty real creation retries', async () => {
    const sender = await activeUser(),
      receiver = await activeUser(),
      input = write(sender, receiver);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        new PostgresPendingNakhStore(database).createPending({
          ...input,
          pendingNakhId: randomUUID(),
          pendingPaymentId: randomUUID(),
          flowId: randomUUID(),
        }),
      ),
    );
    expect(new Set(results.map((result) => result.pendingNakhId)).size).toBe(1);
    const anchors = await database
      .selectFrom('nakh.pending_nakh_reference_anchors')
      .selectAll()
      .where('sender_user_id', '=', sender)
      .execute();
    expect(anchors).toHaveLength(1);
    expect(Object.keys(anchors[0]!).sort()).toEqual([
      'id',
      'nakh_flow_id',
      'pending_payment_id',
      'receiver_product_epoch',
      'receiver_user_id',
      'sender_product_epoch',
      'sender_user_id',
    ]);
    expect(await valid(results[0]!.pendingNakhId)).toBe(true);
    expect(
      await database
        .selectFrom('platform.user_counters')
        .select('pending_nakh_count')
        .where('user_id', '=', sender)
        .executeTakeFirstOrThrow(),
    ).toEqual({ pending_nakh_count: 1 });
  });
  it('denies reference mutation and ordinary source deletion without any purge authority', async () => {
    const id = historicalIds[0]!,
      before = await facts();
    await expect(
      sql`UPDATE nakh.pending_nakh_reference_anchors SET sender_product_epoch=sender_product_epoch+1 WHERE id=${id}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`DELETE FROM nakh.pending_nakh_reference_anchors WHERE id=${id}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`DELETE FROM nakh.pending_nakhes WHERE id=${id}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await facts()).toEqual(before);
  });
  it('rejects borrowed source, flow, participants, lives and intent before changing facts', async () => {
    const anchor = await database
      .selectFrom('nakh.pending_nakh_reference_anchors')
      .selectAll()
      .where('id', '=', historicalIds[0]!)
      .executeTakeFirstOrThrow();
    const before = await facts();
    for (const changed of [
      { id: randomUUID() },
      { nakh_flow_id: randomUUID() },
      { sender_user_id: randomUUID() },
      { receiver_user_id: randomUUID() },
      { sender_product_epoch: anchor.sender_product_epoch + 1 },
      { receiver_product_epoch: anchor.receiver_product_epoch + 1 },
      { pending_payment_id: randomUUID() },
    ])
      await expect(
        database
          .insertInto('nakh.pending_nakh_reference_anchors')
          .values({ ...anchor, ...changed })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    expect(await facts()).toEqual(before);
    expect(await valid(anchor.id)).toBe(true);
  });
  it('rolls back source, intent, counter and events when automatic reference insertion is suppressed', async () => {
    const sender = await activeUser(),
      receiver = await activeUser(),
      input = write(sender, receiver),
      before = await facts();
    await sql`CREATE FUNCTION nakh.suppress_pending_reference_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$`.execute(
      database,
    );
    await sql`CREATE TRIGGER suppress_pending_reference_test BEFORE INSERT ON nakh.pending_nakh_reference_anchors
      FOR EACH ROW EXECUTE FUNCTION nakh.suppress_pending_reference_test()`.execute(database);
    try {
      await expect(
        new PostgresPendingNakhStore(database).createPending(input),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await facts()).toEqual(before);
    } finally {
      await sql`DROP TRIGGER suppress_pending_reference_test ON nakh.pending_nakh_reference_anchors`.execute(
        database,
      );
      await sql`DROP FUNCTION nakh.suppress_pending_reference_test()`.execute(database);
    }
  });
  it('denies reuse of an original source, flow or intent after isolated source-loss corruption', async () => {
    const id = historicalIds[0]!,
      before = await facts();
    const source = await database
      .selectFrom('nakh.pending_nakhes')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role=replica`.execute(connection);
      try {
        await connection.deleteFrom('nakh.pending_nakhes').where('id', '=', id).execute();
      } finally {
        await sql`SET session_replication_role=origin`.execute(connection);
      }
    });
    try {
      for (const changed of [
        { id, nakh_flow_id: randomUUID(), pending_payment_id: randomUUID() },
        { id: randomUUID(), nakh_flow_id: source.nakh_flow_id, pending_payment_id: randomUUID() },
        {
          id: randomUUID(),
          nakh_flow_id: randomUUID(),
          pending_payment_id: source.pending_payment_id,
        },
      ])
        await expect(
          database
            .insertInto('nakh.pending_nakhes')
            .values({ ...source, ...changed })
            .execute(),
        ).rejects.toMatchObject({
          code: '23514',
          message: 'pending Nakh original identity cannot be reused',
        });
    } finally {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await connection.insertInto('nakh.pending_nakhes').values(source).execute();
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    }
    expect(await facts()).toEqual(before);
    expect(await valid(id)).toBe(true);
  });
  it.each([0, 1] as const)(
    'quarantines source %s with a missing original intent across repeated one-row scans',
    async (index) => {
      const id = historicalIds[index]!,
        source = await database
          .selectFrom('nakh.pending_nakhes')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
        intent = await database
          .selectFrom('billing.pending_payments')
          .selectAll()
          .where('id', '=', source.pending_payment_id)
          .executeTakeFirstOrThrow(),
        before = await facts();
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await connection
            .deleteFrom('billing.pending_payments')
            .where('id', '=', intent.id)
            .execute();
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
      try {
        expect(await valid(id)).toBe(false);
        const reconciliation = new PostgresNakhReconciliationStore(database);
        for (let attempt = 0; attempt < 2; attempt++) {
          const runId = await reconciliation.resumeOrStart(randomUUID());
          while (!(await reconciliation.scanNextBatch(runId, 1)).completed) {
            /* exercise durable pagination through the orphan source */
          }
        }
        for (const anomalyType of [
          'pending_nakh_payment_binding_invalid',
          'pending_nakh_payment_status_drift',
        ]) {
          const anomalies = await database
            .selectFrom('billing.reconciliation_anomalies')
            .select(['safe_detail', 'disposition'])
            .where('entity_id', '=', id)
            .where('anomaly_type', '=', anomalyType)
            .execute();
          expect(anomalies).toEqual([
            {
              disposition: 'quarantined',
              safe_detail: { pendingStatus: source.status, paymentStatus: 'missing' },
            },
          ]);
        }
      } finally {
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            await connection.insertInto('billing.pending_payments').values(intent).execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      }
      expect(await valid(id)).toBe(true);
      expect(await facts()).toEqual(before);
    },
  );
  it.each(['sender-life', 'receiver-life', 'intent', 'missing'] as const)(
    'keeps a damaged %s original reference visible to repeated reconciliation',
    async (fault) => {
      const id = historicalIds[0]!,
        anchor = await database
          .selectFrom('nakh.pending_nakh_reference_anchors')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          if (fault === 'missing')
            await connection
              .deleteFrom('nakh.pending_nakh_reference_anchors')
              .where('id', '=', id)
              .execute();
          else
            await connection
              .updateTable('nakh.pending_nakh_reference_anchors')
              .set(
                fault === 'sender-life'
                  ? { sender_product_epoch: anchor.sender_product_epoch + 1 }
                  : fault === 'receiver-life'
                    ? { receiver_product_epoch: anchor.receiver_product_epoch + 1 }
                    : { pending_payment_id: randomUUID() },
              )
              .where('id', '=', id)
              .execute();
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
      try {
        expect(await valid(id)).toBe(false);
        const reconciliation = new PostgresNakhReconciliationStore(database);
        for (let index = 0; index < 2; index++) {
          const runId = await reconciliation.resumeOrStart(randomUUID());
          while (!(await reconciliation.scanNextBatch(runId, 500)).completed) {
            /* complete one durable scan */
          }
        }
        expect(
          await database
            .selectFrom('billing.reconciliation_anomalies')
            .select('id')
            .where('entity_id', '=', id)
            .where('anomaly_type', '=', 'pending_nakh_payment_binding_invalid')
            .execute(),
        ).toHaveLength(1);
      } finally {
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            await connection
              .insertInto('nakh.pending_nakh_reference_anchors')
              .values(anchor)
              .onConflict((conflict) => conflict.column('id').doUpdateSet(anchor))
              .execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      }
      expect(await valid(id)).toBe(true);
    },
  );
});
