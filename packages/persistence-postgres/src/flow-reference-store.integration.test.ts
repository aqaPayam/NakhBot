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
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 original Flow references', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let original: unknown;
  const historicalIds: string[] = [];
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_flow_reference');
    const temporaryRoot = resolve(tmpdir());
    const directory = resolve(await mkdtemp(join(temporaryRoot, 'm8-flow116-')));
    if (!directory.startsWith(`${temporaryRoot}${sep}`))
      throw new Error('Unsafe migration temporary path');
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 115)
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
        await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${sender}::uuid`.execute(
          database,
        );
        const input = write(sender, receiver);
        await new PostgresPendingNakhStore(database).createPending(input);
        historicalIds.push(input.flowId);
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
              .where('id', '=', input.pendingNakhId)
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
  async function activeUser(): Promise<string> {
    const userId = await createReportUser(database, true),
      at = new Date();
    for (const table of [
      'identity.user_settings',
      'billing.credit_accounts',
      'notification.notification_preferences',
    ] as const)
      await database
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
          text: 'Private Flow reference test body',
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
  async function facts(): Promise<unknown> {
    return (
      await sql<{ facts: unknown }>`SELECT jsonb_build_object(
      'flows',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.nakh_flows row),
      'pending',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.pending_nakhes row),
      'delivered',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.nakhes row),
      'pendingReferences',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.pending_nakh_reference_anchors row),
      'deliveredReferences',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.nakh_reference_anchors row),
      'intents',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.pending_payments row),
      'credits',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.credit_transactions row),
      'accounts',(SELECT jsonb_agg(to_jsonb(row) ORDER BY user_id) FROM identity.accounts row),
      'roots',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM identity.account_deletion_records row),
      'preview',(SELECT jsonb_agg(to_jsonb(row) ORDER BY user_id) FROM identity.guest_preview_counters row),
      'counters',(SELECT jsonb_agg(to_jsonb(row) ORDER BY user_id) FROM platform.user_counters row),
      'audit',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM platform.audit_logs row),
      'events',(SELECT jsonb_agg(jsonb_build_object('deletion_cancellation_audit_id',NULL)||to_jsonb(row) ORDER BY id) FROM platform.outbox_events row)) AS facts`.execute(
        database,
      )
    ).rows[0]!.facts;
  }
  async function valid(id: string): Promise<boolean> {
    return (
      await sql<{
        valid: boolean;
      }>`SELECT nakh.original_flow_reference_valid(${id}::uuid) AS valid`.execute(database)
    ).rows[0]!.valid;
  }
  it('refuses mismatched populated references atomically without rewriting old facts', async () => {
    const anchor = await database
      .selectFrom('nakh.pending_nakh_reference_anchors')
      .selectAll()
      .where('nakh_flow_id', '=', historicalIds[0]!)
      .executeTakeFirstOrThrow();
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role=replica`.execute(connection);
      try {
        await connection
          .updateTable('nakh.pending_nakh_reference_anchors')
          .set({ receiver_product_epoch: 1 })
          .where('id', '=', anchor.id)
          .execute();
      } finally {
        await sql`SET session_replication_role=origin`.execute(connection);
      }
    });
    try {
      const before = await facts();
      await expect(runMigrations(isolated.url, resolve('migrations'))).rejects.toMatchObject({
        code: '23514',
      });
      expect(await facts()).toEqual(before);
      expect(
        (
          await sql<{
            reference: string | null;
            applied: number;
          }>`SELECT to_regclass('nakh.flow_reference_anchors')::text AS reference,(SELECT count(*)::integer FROM platform.schema_migrations WHERE name='000116_m8_flow_references.sql') AS applied`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ reference: null, applied: 0 }]);
    } finally {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await connection
            .updateTable('nakh.pending_nakh_reference_anchors')
            .set({ receiver_product_epoch: anchor.receiver_product_epoch })
            .where('id', '=', anchor.id)
            .execute();
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    }
    expect(await facts()).toEqual(original);
  });
  it('upgrades paid and unpaid original deleted lives once under twenty migration races', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(results.flatMap((x) => x.applied)).toEqual([
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
      '000153_m9_candidate_media_authority.sql',
      '000154_m9_preview_consumption_disposition.sql',
      '000155_m9_guest_preview_delivery.sql',
    ]);
    expect(await facts()).toEqual(original);
    for (const id of historicalIds) expect(await valid(id)).toBe(true);
    expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([]);
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000116_m8_flow_references.sql',
    );
    const catalog = await readDeletionCatalog(database);
    expect(catalog.tables).toHaveLength(153);
    expect(catalog.tables.reduce((count, table) => count + table.columns.length, 0)).toBe(1421);
    expect(catalog.foreignKeys).toHaveLength(307);
    assertDeletionCatalogCoverage(catalog);
  });
  it('creates one five-field original Flow reference during twenty genuine pending retries', async () => {
    const sender = await activeUser(),
      receiver = await activeUser(),
      input = write(sender, receiver);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        new PostgresPendingNakhStore(database).createPending({
          ...input,
          flowId: randomUUID(),
          pendingNakhId: randomUUID(),
          pendingPaymentId: randomUUID(),
        }),
      ),
    );
    expect(new Set(results.map((x) => x.pendingNakhId)).size).toBe(1);
    const references = await database
      .selectFrom('nakh.flow_reference_anchors')
      .selectAll()
      .where('sender_user_id', '=', sender)
      .execute();
    expect(references).toHaveLength(1);
    expect(Object.keys(references[0]!).sort()).toEqual([
      'id',
      'receiver_product_epoch',
      'receiver_user_id',
      'sender_product_epoch',
      'sender_user_id',
    ]);
    expect(await valid(references[0]!.id)).toBe(true);
    expect(
      await database
        .selectFrom('platform.user_counters')
        .select('pending_nakh_count')
        .where('user_id', '=', sender)
        .executeTakeFirstOrThrow(),
    ).toEqual({ pending_nakh_count: 1 });
  });
  it('denies borrowed identity, participants and lives, mutation and ordinary Flow removal', async () => {
    const anchor = await database
        .selectFrom('nakh.flow_reference_anchors')
        .selectAll()
        .where('id', '=', historicalIds[0]!)
        .executeTakeFirstOrThrow(),
      before = await facts();
    for (const change of [
      { id: randomUUID() },
      { sender_user_id: randomUUID() },
      { receiver_user_id: randomUUID() },
      { sender_product_epoch: 1 },
      { receiver_product_epoch: 1 },
    ])
      await expect(
        database
          .insertInto('nakh.flow_reference_anchors')
          .values({ ...anchor, ...change })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database
        .updateTable('nakh.flow_reference_anchors')
        .set({ sender_product_epoch: 1 })
        .where('id', '=', anchor.id)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database.deleteFrom('nakh.flow_reference_anchors').where('id', '=', anchor.id).execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database.deleteFrom('nakh.nakh_flows').where('id', '=', anchor.id).execute(),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await facts()).toEqual(before);
    expect(await valid(anchor.id)).toBe(true);
  });
  it('rolls back original Flow, pending intent, counter and events if reference creation is suppressed', async () => {
    const sender = await activeUser(),
      receiver = await activeUser(),
      input = write(sender, receiver),
      before = await facts();
    await sql`CREATE FUNCTION nakh.suppress_flow_reference_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$`.execute(
      database,
    );
    await sql`CREATE TRIGGER suppress_flow_reference_test BEFORE INSERT ON nakh.flow_reference_anchors FOR EACH ROW EXECUTE FUNCTION nakh.suppress_flow_reference_test()`.execute(
      database,
    );
    try {
      await expect(
        new PostgresPendingNakhStore(database).createPending(input),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await facts()).toEqual(before);
    } finally {
      await sql`DROP TRIGGER suppress_flow_reference_test ON nakh.flow_reference_anchors`.execute(
        database,
      );
      await sql`DROP FUNCTION nakh.suppress_flow_reference_test()`.execute(database);
    }
  });
  it('rejects retired Flow identity and exact-life direction after rolled-back source loss', async () => {
    const sender = await activeUser(),
      receiver = await activeUser(),
      id = randomUUID();
    await database
      .insertInto('nakh.nakh_flows')
      .values({ id, sender_user_id: sender, receiver_user_id: receiver })
      .execute();
    const before = await facts();
    for (const reuseId of [id, randomUUID()]) {
      await expect(
        database.transaction().execute(async (tx) => {
          await sql`SET LOCAL session_replication_role=replica`.execute(tx);
          await tx.deleteFrom('nakh.nakh_flows').where('id', '=', id).execute();
          await sql`SET LOCAL session_replication_role=origin`.execute(tx);
          await tx
            .insertInto('nakh.nakh_flows')
            .values({ id: reuseId, sender_user_id: sender, receiver_user_id: receiver })
            .execute();
        }),
      ).rejects.toMatchObject({ code: reuseId === id ? '23514' : '23505' });
    }
    expect(await facts()).toEqual(before);
    expect(await valid(id)).toBe(true);
  });
  it.each([
    'sender_user_id',
    'receiver_user_id',
    'sender_product_epoch',
    'receiver_product_epoch',
  ] as const)(
    'detects physical %s corruption and verifies restored original proof',
    async (column) => {
      const anchor = await database
        .selectFrom('nakh.flow_reference_anchors')
        .selectAll()
        .where('id', '=', historicalIds[0]!)
        .executeTakeFirstOrThrow();
      await database.transaction().execute(async (tx) => {
        await sql`SET LOCAL session_replication_role=replica`.execute(tx);
        await tx
          .updateTable('nakh.flow_reference_anchors')
          .set({ [column]: column.endsWith('epoch') ? 1 : randomUUID() })
          .where('id', '=', anchor.id)
          .execute();
        await sql`SET LOCAL session_replication_role=origin`.execute(tx);
        expect(
          (
            await sql<{
              valid: boolean;
            }>`SELECT nakh.original_flow_reference_valid(${anchor.id}::uuid) AS valid`.execute(tx)
          ).rows[0]!.valid,
        ).toBe(false);
        await sql`SET LOCAL session_replication_role=replica`.execute(tx);
        await tx
          .updateTable('nakh.flow_reference_anchors')
          .set(anchor)
          .where('id', '=', anchor.id)
          .execute();
        await sql`SET LOCAL session_replication_role=origin`.execute(tx);
      });
      expect(await valid(anchor.id)).toBe(true);
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
    },
  );
});
