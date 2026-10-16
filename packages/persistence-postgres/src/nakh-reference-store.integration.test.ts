import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateDirectNakhCommand } from '@nakh/contracts';
import { ViewNakhProfileHandler, type CreateDirectNakhWrite } from '@nakh/application';
import { createDatabase, type NakhDatabase, type NakhReferenceAnchorTable } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { PostgresDirectNakhStore } from './direct-nakh-store.js';
import { PostgresDeliveredNakhStore } from './delivered-nakh-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresNakhReconciliationStore } from './nakh-reconciliation-store.js';
import { PostgresNakhOperationalMetricsStore } from './nakh-operational-metrics-store.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { PostgresAccountDeletionStore } from './account-deletion-store.js';
import { createReportUser } from './testing/report-fixture.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 original funded Nakh references', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let survivor: string, owner: string, historicalId: string, originalFacts: unknown[];
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_nakh_reference');
    const directory = await mkdtemp(join(tmpdir(), 'm8-nakh106-'));
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 106)
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
    // Migration 109 adds the provable original recipient epoch to existing
    // history. Compare every old field and require the new value to be zero.
    originalFacts[9] = (
      await database.selectFrom('notification.notifications').selectAll().orderBy('id').execute()
    ).map((row) => ({ ...row, product_epoch: 0 }));
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
      database.selectFrom('nakh.nakh_receiver_actions').selectAll().orderBy('id').execute(),
      database.selectFrom('billing.credit_transactions').selectAll().orderBy('id').execute(),
      database.selectFrom('billing.credit_accounts').selectAll().orderBy('user_id').execute(),
      database.selectFrom('platform.idempotency_records').selectAll().orderBy('id').execute(),
      database.selectFrom('platform.audit_logs').selectAll().orderBy('id').execute(),
      database
        .selectFrom('platform.outbox_events')
        .selectAll()
        .orderBy('id')
        .execute()
        .then((rows) =>
          rows.map((row) => Object.assign({ deletion_cancellation_audit_id: null }, row)),
        ),
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
  async function reconcileOriginalFunding(previousFundingCount?: number): Promise<string> {
    const store = new PostgresNakhReconciliationStore(database);
    const runs = await Promise.all(
      Array.from({ length: 20 }, () => store.resumeOrStart(randomUUID())),
    );
    expect(new Set(runs).size).toBe(1);
    const runId = runs[0]!;
    if (previousFundingCount !== undefined) {
      const metrics = new PostgresNakhOperationalMetricsStore(database);
      expect((await metrics.measure()).fundingInvariantMismatchCount).toBe(previousFundingCount);
      expect((await store.scanNextBatch(runId, 500)).completed).toBe(false);
      expect((await metrics.measure()).fundingInvariantMismatchCount).toBe(previousFundingCount);
    }
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.scanNextBatch(runId, 500)),
    );
    expect(outcomes.some((row) => row.status === 'fulfilled' && row.value.completed)).toBe(true);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        expect(outcome.reason as unknown).toMatchObject({
          code: 'conflict',
          message: 'error.nakh.reconciliation_complete',
        });
    return runId;
  }

  it('upgrades once under twenty retries without changing deleted-owner sources or financial facts', async () => {
    const historical = await database
      .selectFrom('nakh.nakhes')
      .select('credit_transaction_id')
      .where('id', '=', historicalId)
      .executeTakeFirstOrThrow();
    const setEpoch = async (value: number): Promise<void> => {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await sql`UPDATE billing.credit_transactions SET product_epoch=${value} WHERE id=${historical.credit_transaction_id}::uuid`.execute(
            connection,
          );
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    };
    // Isolated negative provenance corruption, not a fresh return or reset.
    await setEpoch(1);
    try {
      await expect(runMigrations(isolated.url, resolve('migrations'))).rejects.toThrow(
        'legacy Nakh original funding life is unproven',
      );
      expect(
        (
          await sql<{
            present: boolean;
          }>`SELECT to_regprocedure('nakh.original_funding_life_valid(nakh.nakhes)') IS NOT NULL AS present`.execute(
            database,
          )
        ).rows[0]!.present,
      ).toBe(false);
    } finally {
      await setEpoch(0);
    }
    const directory = await mkdtemp(join(tmpdir(), 'm8-nakh109-'));
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 109)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      expect((await runMigrations(isolated.url, directory)).applied).toEqual([
        '000107_m8_nakh_funding_lives.sql',
        '000108_m8_unreferenced_like_purge.sql',
        '000109_m8_notification_original_lives.sql',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const setReferenceEpoch = async (epoch: number): Promise<void> =>
      database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await connection
            .updateTable('nakh.nakh_reference_anchors')
            .set({ receiver_product_epoch: epoch })
            .where('id', '=', historicalId)
            .execute();
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    await setReferenceEpoch(1);
    try {
      await expect(runMigrations(isolated.url, resolve('migrations'))).rejects.toThrow(
        'retained Nakh routing lacks original source proof',
      );
      const unchanged = await sql<{
        original: boolean;
      }>`SELECT confrelid='nakh.nakhes'::regclass AS original
        FROM pg_constraint WHERE conname IN ('credit_transactions_nakh_fk','matches_source_nakh_fk')`.execute(
        database,
      );
      expect(unchanged.rows).toEqual([{ original: true }, { original: true }]);
      expect(
        (
          await sql<{ absent: boolean }>`SELECT
        to_regprocedure('nakh.require_live_funded_reference()') IS NULL AS absent`.execute(database)
        ).rows[0]!.absent,
      ).toBe(true);
    } finally {
      await setReferenceEpoch(0);
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(results.flatMap((result) => result.applied)).toEqual([
      '000110_m8_nakh_retained_links.sql',
      '000111_m8_funded_nakh_archival.sql',
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
      '000132_m8_sample_source_cleanup.sql',
      '000133_m8_liked_by_request_life.sql',
      '000134_m7_account_action_proof_index.sql',
      '000135_m8_deletion_sessions.sql',
      '000136_m8_ephemeral_checkpoint.sql',
      '000137_m8_retention_manifest.sql',
      '000138_m8_final_verification.sql',
      '000139_m8_account_control.sql',
      '000140_m8_deletion_localization.sql',
      '000141_m8_return_approval.sql',
      '000142_m8_fresh_account_return.sql',
      '000143_m8_return_localization.sql',
      '000144_m8_fresh_entry_localization.sql',
      '000145_m8_retention_policy.sql',
      '000146_m8_retained_source_membership.sql',
      '000147_m8_support_content_release.sql',
      '000148_m8_protected_profile_change_lives.sql',
      '000149_m8_live_retained_safety_holds.sql',
      '000150_m8_batched_photo_sources.sql',
      '000151_m8_minimal_review_response_receipts.sql',
      '000152_m9_signup_presentation.sql',
    ]);
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
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000107_m8_nakh_funding_lives.sql',
    );
    expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([]);
    const catalog = await readDeletionCatalog(database);
    expect(catalog.tables).toHaveLength(153);
    expect(catalog.tables.reduce((count, table) => count + table.columns.length, 0)).toBe(1419);
    expect(catalog.foreignKeys).toHaveLength(307);
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
  it('denies twenty additional spends against one original Nakh without changing its financial or command facts', async () => {
    const scene = await prepared();
    await scene.store.createDirect(scene.write);
    const original = await facts();
    const ledger = new PostgresCreditLedgerStore(database);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        ledger.append({
          transactionId: randomUUID(),
          userId: scene.sender,
          transactionType: 'spend_nakh',
          amount: -2n,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          reference: { nakhId: scene.write.nakhId },
        }),
      ),
    );
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected')
        expect(outcome.reason as unknown).toMatchObject({
          code: '23505',
          constraint: 'credit_transactions_nakh_idx',
        });
    }
    expect(await facts()).toEqual(original);
    expect((await scene.store.createDirect(scene.write)).replayed).toBe(true);
  });
  it('denies borrowed funding life at the actual receiver-command commit and permits its original retry', async () => {
    const scene = await prepared();
    await scene.store.createDirect(scene.write);
    const original = await facts();
    const setEpoch = async (value: number): Promise<void> => {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await sql`UPDATE billing.credit_transactions SET product_epoch=${value} WHERE id=${scene.write.creditTransactionId}::uuid`.execute(
            connection,
          );
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    };
    const command = {
      commandType: 'nakh.view-profile' as const,
      schemaVersion: 1 as const,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      actor: { kind: 'user' as const, userId: scene.receiver },
      occurredAt: new Date().toISOString(),
      locale: 'en' as const,
      data: { nakhId: scene.write.nakhId, expectedVersion: 1 },
    };
    const handler = new ViewNakhProfileHandler(new PostgresDeliveredNakhStore(database), {
      uuid: randomUUID,
    });
    // Negative corruption only: no return or payment transfer is authorized.
    await setEpoch(1);
    try {
      const corrupted = await facts();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 20 }, () => handler.execute(command)),
      );
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected')
          expect(outcome.reason as unknown).toMatchObject({
            code: '23514',
            where: expect.stringContaining('require_original_funding_life()') as unknown,
          });
      }
      expect(await facts()).toEqual(corrupted);
    } finally {
      await setEpoch(0);
    }
    expect(await facts()).toEqual(original);
    expect((await handler.execute(command)).replayed).toBe(false);
    expect((await handler.execute(command)).replayed).toBe(true);
  });
  it.each([
    'credit-life',
    'reference-life',
    'receiver-reference-life',
    'missing-reference',
  ] as const)(
    'reconciles original Nakh funding and reference lives under competing workers: %s',
    async (fault) => {
      await runMigrations(isolated.url, resolve('migrations'));
      const scene = await prepared();
      const delivered = await scene.store.createDirect(scene.write);
      const original = await facts();
      const originalAnchor = await anchor(delivered.nakhId);
      const setEpoch = async (epoch: number): Promise<void> =>
        database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            if (fault === 'credit-life')
              await connection
                .updateTable('billing.credit_transactions')
                .set({ product_epoch: epoch })
                .where('id', '=', scene.write.creditTransactionId)
                .execute();
            else if (fault === 'missing-reference') {
              if (epoch === 1)
                await connection
                  .deleteFrom('nakh.nakh_reference_anchors')
                  .where('id', '=', delivered.nakhId)
                  .execute();
              else
                await connection
                  .insertInto('nakh.nakh_reference_anchors')
                  .values(originalAnchor)
                  .execute();
            } else
              await connection
                .updateTable('nakh.nakh_reference_anchors')
                .set(
                  fault === 'receiver-reference-life'
                    ? { receiver_product_epoch: epoch }
                    : { sender_product_epoch: epoch },
                )
                .where('id', '=', delivered.nakhId)
                .execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      await setEpoch(1);
      try {
        const corrupted = await facts();
        const runId = await reconcileOriginalFunding();
        const findings = await database
          .selectFrom('billing.reconciliation_anomalies')
          .select(['anomaly_type', 'entity_type', 'entity_id', 'disposition', 'safe_detail'])
          .where('run_id', '=', runId)
          .where('entity_id', '=', delivered.nakhId)
          .execute();
        expect(findings).toEqual([
          {
            anomaly_type: 'delivered_nakh_funding_proof_invalid',
            entity_type: 'nakh',
            entity_id: delivered.nakhId,
            disposition: 'quarantined',
            safe_detail: {
              fundingType: 'credits',
              creditProofCount: '1',
              paymentProofCount: '0',
              originalFundingLifeValid: String(fault !== 'credit-life'),
              originalFundingBindingValid: 'false',
              originalReferenceValid: String(fault === 'credit-life'),
            },
          },
        ]);
        expect(
          (await new PostgresNakhOperationalMetricsStore(database).measure())
            .fundingInvariantMismatchCount,
        ).toBe(1);
        expect(await facts()).toEqual(corrupted);
        const retryRunId = await reconcileOriginalFunding(1);
        expect(
          await database
            .selectFrom('billing.reconciliation_anomalies')
            .select('id')
            .where('entity_id', '=', delivered.nakhId)
            .where('anomaly_type', '=', 'delivered_nakh_funding_proof_invalid')
            .execute(),
        ).toHaveLength(1);
        expect(retryRunId).not.toBe(runId);
        expect(
          (await new PostgresNakhOperationalMetricsStore(database).measure())
            .fundingInvariantMismatchCount,
        ).toBe(1);
        expect(await facts()).toEqual(corrupted);
      } finally {
        await setEpoch(0);
      }
      expect(await anchor(delivered.nakhId)).toEqual(originalAnchor);
      const cleanRunId = await reconcileOriginalFunding(1);
      expect(
        await database
          .selectFrom('billing.reconciliation_anomalies')
          .select('id')
          .where('run_id', '=', cleanRunId)
          .where('anomaly_type', '=', 'delivered_nakh_funding_proof_invalid')
          .execute(),
      ).toEqual([]);
      expect(
        (await new PostgresNakhOperationalMetricsStore(database).measure())
          .fundingInvariantMismatchCount,
      ).toBe(0);
      expect(await facts()).toEqual(original);
    },
  );

  it('rejects malformed persisted observations without advancing or masking them with a completed run', async () => {
    await runMigrations(isolated.url, resolve('migrations'));
    await reconcileOriginalFunding();
    const store = new PostgresNakhReconciliationStore(database);
    const runId = await store.resumeOrStart(randomUUID());
    const original = await database
      .selectFrom('billing.reconciliation_runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    const sourceFacts = await facts();
    const malformed: readonly unknown[] = [
      null,
      [],
      {},
      { quotaDriftCount: '0', fundingInvariantMismatchCount: 0 },
      { quotaDriftCount: -1, fundingInvariantMismatchCount: 0 },
      { quotaDriftCount: 0.5, fundingInvariantMismatchCount: 0 },
      { quotaDriftCount: 9007199254740992, fundingInvariantMismatchCount: 0 },
      { quotaDriftCount: 0, fundingInvariantMismatchCount: -1 },
      { quotaDriftCount: 0, fundingInvariantMismatchCount: 0, privateText: 'never a metric' },
    ];
    try {
      for (const observations of malformed) {
        const cursor = { ...original.cursor, observations };
        await database
          .updateTable('billing.reconciliation_runs')
          .set({ cursor })
          .where('id', '=', runId)
          .execute();
        await expect(store.scanNextBatch(runId, 500)).rejects.toMatchObject({
          code: 'conflict',
          message: 'error.nakh.reconciliation_cursor_invalid',
        });
        await expect(new PostgresNakhOperationalMetricsStore(database).measure()).rejects.toThrow();
        expect(
          await database
            .selectFrom('billing.reconciliation_runs')
            .selectAll()
            .where('id', '=', runId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ ...original, cursor });
        expect(
          await database
            .selectFrom('billing.reconciliation_anomalies')
            .select('id')
            .where('run_id', '=', runId)
            .execute(),
        ).toEqual([]);
      }
    } finally {
      await database
        .updateTable('billing.reconciliation_runs')
        .set({ cursor: original.cursor })
        .where('id', '=', runId)
        .execute();
      await reconcileOriginalFunding();
    }
    expect(await facts()).toEqual(sourceFacts);
  });

  it('routes retained funding links through exact original anchors while requiring live sources', async () => {
    await runMigrations(isolated.url, resolve('migrations'));
    const links = await sql<{ name: string; target: string; deferred: boolean }>`
      SELECT conname AS name,target_schema.nspname||'.'||target.relname AS target,
        condeferrable AND condeferred AS deferred
      FROM pg_constraint JOIN pg_class target ON target.oid=confrelid
      JOIN pg_namespace target_schema ON target_schema.oid=target.relnamespace
      WHERE conname IN ('credit_transactions_nakh_fk','matches_source_nakh_fk')
      ORDER BY conname`.execute(database);
    expect(links.rows).toEqual([
      {
        name: 'credit_transactions_nakh_fk',
        target: 'nakh.nakh_reference_anchors',
        deferred: true,
      },
      { name: 'matches_source_nakh_fk', target: 'nakh.nakh_reference_anchors', deferred: true },
    ]);
    const original = await facts();
    const originalAnchor = await anchor(historicalId);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        database.deleteFrom('nakh.nakhes').where('id', '=', historicalId).execute(),
      ),
    );
    expect(outcomes.every((row) => row.status === 'rejected')).toBe(true);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        expect(outcome.reason as unknown).toMatchObject({ code: '55000' });
    expect(await facts()).toEqual(original);
    expect(await anchor(historicalId)).toEqual(originalAnchor);
  });
});
