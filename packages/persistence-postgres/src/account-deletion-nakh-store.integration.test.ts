import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionStore } from './account-deletion-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionChatStore } from './account-deletion-chat-store.js';
import { PostgresAccountDeletionMatchStore } from './account-deletion-match-store.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresAccountDeletionNakhStore } from './account-deletion-nakh-store.js';
import { PostgresDirectNakhStore } from './direct-nakh-store.js';
import { PostgresDeliveredNakhStore } from './delivered-nakh-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';
import { PostgresFundingStore } from './funding-store.js';
import { PostgresTelegramStarsReceiptStore } from './payment-receipt-store.js';
import { PostgresNakhReconciliationStore } from './nakh-reconciliation-store.js';
import { PostgresNakhOperationalMetricsStore } from './nakh-operational-metrics-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 bounded original funded Nakh archival', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionNakhStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_nakh_archive');
    await runMigrations(isolated.url, resolve('migrations'));
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000112_m8_pending_nakh_references.sql',
    );
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionNakhStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,
      available_at=clock_timestamp()+interval '1 day'`.execute(database);
  });
  async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
    const result = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(result).toHaveLength(1);
    return result[0]!;
  }
  async function scene(
    actions = 0,
    funding: 'credits' | 'telegram_stars' = 'credits',
    accepted = false,
    leaseMs = 120000,
  ): Promise<{
    lease: AccountDeletionLease;
    nakhId: string;
    receiver: string;
    replayFunding: (() => Promise<unknown>) | undefined;
  }> {
    const receiver = await createReportUser(database, true),
      at = new Date();
    for (const table of [
      'identity.user_settings',
      'billing.credit_accounts',
      'notification.notification_preferences',
    ] as const)
      await database
        .insertInto(table)
        .values({ user_id: receiver, created_at: at, updated_at: at })
        .execute();
    let nakhId!: string, replayFunding: (() => Promise<unknown>) | undefined;
    const item = await createDeletionFixture(database, async (sender) => {
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
      if (funding === 'credits') {
        await new PostgresCreditLedgerStore(database).append({
          transactionId: randomUUID(),
          userId: sender,
          transactionType: 'admin_adjustment',
          amount: 4n,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
        });
        const result = await new PostgresDirectNakhStore(database).createDirect({
          command: {
            commandId: randomUUID(),
            commandType: 'nakh.create-direct',
            schemaVersion: 1,
            actor: { kind: 'user', userId: sender },
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
            occurredAt: at.toISOString(),
            locale: 'en',
            data: { targetUserId: receiver, text: 'Ordinary Nakh body to remove' },
          },
          flowId: randomUUID(),
          nakhId: randomUUID(),
          creditTransactionId: randomUUID(),
          historyId: randomUUID(),
          flowEventId: randomUUID(),
          deliveredEventId: randomUUID(),
        });
        nakhId = result.nakhId;
      } else {
        const pending = await new PostgresPendingNakhStore(database).createPending({
          command: {
            commandId: randomUUID(),
            commandType: 'nakh.create-pending',
            schemaVersion: 1,
            actor: { kind: 'user', userId: sender },
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
            occurredAt: at.toISOString(),
            locale: 'en',
            data: {
              targetUserId: receiver,
              text: 'Ordinary Nakh body to remove',
              autoSettleAuthorized: true,
            },
          },
          flowId: randomUUID(),
          pendingNakhId: randomUUID(),
          pendingPaymentId: randomUUID(),
          flowEventId: randomUUID(),
          pendingEventId: randomUUID(),
        });
        const cleartext = randomBytes(24).toString('base64url'),
          digest = (value: string): string => createHash('sha256').update(value).digest('hex');
        const attempt = await new PostgresFundingStore(database).prepareStarsAttempt({
          paymentRecordId: randomUUID(),
          fundingIntentId: pending.fundingIntentId,
          expectedVersion: 1,
          userId: sender,
          idempotencyKey: randomUUID(),
          providerEnvironment: 'test',
          providerBotIdDigest: 'b'.repeat(64),
          payload: {
            cleartext,
            digest: digest(cleartext),
            ciphertext: randomBytes(64),
            keyId: 'm8-archive-test',
          },
        });
        const receipts = new PostgresTelegramStarsReceiptStore(
          database,
          { uuid: randomUUID },
          { digest },
        );
        const identity = await database
          .selectFrom('identity.telegram_identities')
          .select('telegram_user_id')
          .where('user_id', '=', sender)
          .executeTakeFirstOrThrow();
        const event = randomUUID();
        expect(
          await receipts.recordSuccessfulPayment({
            providerEventId: event,
            telegramUserId: identity.telegram_user_id,
            invoicePayload: cleartext,
            currency: 'XTR',
            totalAmount: attempt.starsAmount,
            providerEnvironment: 'test',
            providerBotIdDigest: 'b'.repeat(64),
            telegramChargeId: `synthetic:${randomUUID()}`,
            evidence: {
              digest: digest(event),
              ciphertext: randomBytes(64),
              keyId: 'm8-archive-test',
              schemaVersion: 1,
            },
          }),
        ).toMatchObject({ outcome: 'receipt_recorded' });
        const fulfillment = (
          await receipts.claimFulfillments({ owner: 'm8-archive', leaseMs: 120000, limit: 100 })
        ).find((row) => row.paymentRecordId === attempt.paymentRecordId)!;
        expect(fulfillment).toBeDefined();
        nakhId = randomUUID();
        const fulfillmentWrite = {
          paymentRecordId: attempt.paymentRecordId,
          owner: 'm8-archive',
          fenceToken: fulfillment.fenceToken,
          nakhId,
          historyId: randomUUID(),
          refundRecordId: randomUUID(),
          deliveredEventId: randomUUID(),
          paymentTerminalEventId: randomUUID(),
        };
        expect(await receipts.fulfillPendingNakh(fulfillmentWrite)).toMatchObject({
          replayed: false,
        });
        replayFunding = () =>
          receipts.fulfillPendingNakh({
            ...fulfillmentWrite,
            nakhId: randomUUID(),
            historyId: randomUUID(),
          });
      }
      const delivered = new PostgresDeliveredNakhStore(database);
      if (actions > 0) {
        const source = await database
          .selectFrom('nakh.nakhes')
          .select('version')
          .where('id', '=', nakhId)
          .executeTakeFirstOrThrow();
        await delivered.viewProfile({
          command: {
            commandId: randomUUID(),
            commandType: 'nakh.view-profile',
            schemaVersion: 1,
            actor: { kind: 'user', userId: receiver },
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
            locale: 'en',
            data: { nakhId, expectedVersion: source.version },
          },
          actionId: randomUUID(),
          historyId: randomUUID(),
          eventId: randomUUID(),
        });
        // The current command marks seen once. Synthetic structurally valid
        // report rows exercise the schema's unbounded legacy action population;
        // they are not evidence of repeated successful view commands.
        await sql`INSERT INTO nakh.nakh_receiver_actions
          (id,nakh_id,receiver_user_id,action_type,idempotency_key,request_id)
          SELECT gen_random_uuid(),${nakhId}::uuid,${receiver}::uuid,'report',
            gen_random_uuid()::text,gen_random_uuid() FROM generate_series(1,${actions - 1})`.execute(
          database,
        );
      }
      if (accepted) {
        const source = await database
          .selectFrom('nakh.nakhes')
          .select('version')
          .where('id', '=', nakhId)
          .executeTakeFirstOrThrow();
        await delivered.accept({
          command: {
            commandId: randomUUID(),
            commandType: 'nakh.accept',
            schemaVersion: 1,
            actor: { kind: 'user', userId: receiver },
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
            locale: 'en',
            data: { nakhId, expectedVersion: source.version },
          },
          actionId: randomUUID(),
          historyId: randomUUID(),
          nakhEventId: randomUUID(),
          matchId: randomUUID(),
          chatSessionId: randomUUID(),
          matchEventId: randomUUID(),
          likeClosedEventId: randomUUID(),
          auditId: randomUUID(),
        });
      }
    });
    const shared = await claim(),
      closure = new PostgresAccountDeletionSharedStore(database);
    while ((await closure.closeNext(shared)).hasMore) {
      /* bounded pair closure */
    }
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(shared);
    const evidence = await claim();
    if (accepted) {
      const chats = new PostgresAccountDeletionChatStore(database),
        matches = new PostgresAccountDeletionMatchStore(database);
      while ((await chats.archiveNext(evidence)).hasMore) {
        /* bounded chat archival */
      }
      while ((await matches.archiveNext(evidence)).hasMore) {
        /* bounded Match archival */
      }
    }
    expect(await new PostgresAccountDeletionProfileStore(database).archive(evidence)).toMatchObject(
      { archived: true },
    );
    expect(await checkpoints.finishEvidence(evidence)).toMatchObject({
      phase: 'product_data',
      checkpointVersion: 3,
    });
    const lease = await claim(leaseMs);
    expect(lease.deletionRecordId).toBe(item.recordId);
    return { lease, nakhId, receiver, replayFunding };
  }
  async function facts(lease: AccountDeletionLease): Promise<Record<string, unknown>> {
    return (
      await sql<{ facts: Record<string, unknown> }>`SELECT jsonb_build_object(
      'credits',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.credit_transactions row),
      'payments',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.payment_records row),
      'provider',(SELECT jsonb_agg(to_jsonb(row) ORDER BY payment_record_id) FROM billing.telegram_stars_receipts row),
      'fulfillments',(SELECT jsonb_agg(to_jsonb(row) ORDER BY payment_record_id) FROM billing.payment_fulfillments row),
      'pending',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.pending_nakhes row),
      'anchors',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.nakh_reference_anchors row),
      'flows',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.nakh_flows row),
      'account',(SELECT to_jsonb(row) FROM identity.accounts row WHERE user_id=${lease.userId}::uuid),
      'root',(SELECT to_jsonb(row) FROM identity.account_deletion_records row WHERE id=${lease.deletionRecordId}::uuid),
      'preview',(SELECT to_jsonb(row) FROM identity.guest_preview_counters row WHERE user_id=${lease.userId}::uuid)) AS facts`.execute(
        database,
      )
    ).rows[0]!.facts;
  }
  async function ordinary(nakhId: string): Promise<unknown> {
    return (
      await sql<{ facts: unknown }>`SELECT jsonb_build_object(
      'source',(SELECT to_jsonb(row) FROM nakh.nakhes row WHERE id=${nakhId}::uuid),
      'history',(SELECT jsonb_agg(to_jsonb(row) ORDER BY nakh_version) FROM nakh.nakh_status_history row WHERE nakh_id=${nakhId}::uuid),
      'actions',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.nakh_receiver_actions row WHERE nakh_id=${nakhId}::uuid),
      'receipts',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM identity.account_deletion_nakh_receipts row WHERE nakh_id=${nakhId}::uuid)) AS facts`.execute(
        database,
      )
    ).rows[0]!.facts;
  }
  async function reconcile(): Promise<string> {
    const scans = new PostgresNakhReconciliationStore(database),
      run = await scans.resumeOrStart(randomUUID());
    while (!(await scans.scanNextBatch(run, 500)).completed) {
      /* full authoritative scan */
    }
    return run;
  }
  it('purges 205 receiver action rows in bounded batches under twenty retries without changing retained facts', async () => {
    const item = await scene(205),
      original = await facts(item.lease);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.purgeNext(item.lease)),
    );
    expect(
      results
        .filter((row) => row.purgedRows > 0)
        .map((row) => row.purgedRows)
        .sort((a, b) => a - b),
    ).toEqual([9, 100, 100]);
    expect(await ordinary(item.nakhId)).toMatchObject({
      source: null,
      history: null,
      actions: null,
    });
    expect(await facts(item.lease)).toEqual(original);
    const receipts = (
      await sql<{ final: boolean; summary: unknown }>`SELECT final_batch AS final,summary
      FROM identity.account_deletion_nakh_receipts WHERE nakh_id=${item.nakhId}::uuid ORDER BY archived_at`.execute(
        database,
      )
    ).rows;
    expect(receipts).toHaveLength(3);
    expect(receipts.filter((row) => row.final)).toHaveLength(1);
    expect(receipts.filter((row) => !row.final).every((row) => row.summary === null)).toBe(true);
    expect(JSON.stringify(receipts)).not.toContain('Ordinary Nakh body to remove');
    expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
    const run = await reconcile();
    expect(
      await database
        .selectFrom('billing.reconciliation_anomalies')
        .select('id')
        .where('run_id', '=', run)
        .execute(),
    ).toEqual([]);
    expect(
      (await new PostgresNakhOperationalMetricsStore(database).measure())
        .fundingInvariantMismatchCount,
    ).toBe(0);
    await expect(
      new PostgresDeliveredNakhStore(database).readDetail(item.receiver, item.nakhId),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('serializes competing participant deletion roots without duplicate archival or financial changes', async () => {
    const item = await scene();
    const key = randomBytes(32);
    const deletion = new PostgresAccountDeletionStore(database, {
      activeKeyId: 'm8-nakh-competing',
      keys: new Map([['m8-nakh-competing', key]]),
    });
    try {
      const account = await database
        .selectFrom('identity.accounts')
        .select('version')
        .where('user_id', '=', item.receiver)
        .executeTakeFirstOrThrow();
      const proof = await deletion.prepare({
        actor: { kind: 'user', userId: item.receiver },
        requestId: randomUUID(),
        expectedAccountVersion: account.version,
      });
      const commandId = randomUUID();
      await deletion.request({
        commandId,
        commandType: 'account.delete',
        schemaVersion: 1,
        actor: { kind: 'user', userId: item.receiver },
        requestId: randomUUID(),
        idempotencyKey: `m8-nakh-competing:${commandId}`,
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
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    const shared = await claim();
    const closure = new PostgresAccountDeletionSharedStore(database);
    while ((await closure.closeNext(shared)).hasMore) {
      /* bounded shared closure */
    }
    await checkpoints.finishShared(shared);
    const evidence = await claim();
    expect(await new PostgresAccountDeletionProfileStore(database).archive(evidence)).toMatchObject(
      { archived: true },
    );
    expect(await checkpoints.finishEvidence(evidence)).toMatchObject({ phase: 'product_data' });
    const counterpart = await claim();
    expect(counterpart.userId).toBe(item.receiver);
    const senderFacts = await facts(item.lease),
      receiverFacts = await facts(counterpart);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.purgeNext(index % 2 === 0 ? item.lease : counterpart),
      ),
    );
    expect(results.filter((result) => result.purgedRows > 0)).toHaveLength(1);
    expect(results.every((result) => !result.hasMore)).toBe(true);
    expect(await facts(item.lease)).toEqual(senderFacts);
    expect(await facts(counterpart)).toEqual(receiverFacts);
    expect(await ordinary(item.nakhId)).toMatchObject({ receipts: [expect.any(Object)] });
  });
  it.each(['credits', 'telegram_stars'] as const)(
    'preserves real %s funding and archived acceptance while denying new effects',
    async (funding) => {
      const item = await scene(0, funding, true),
        original = await facts(item.lease);
      const originalSource = await database
        .selectFrom('nakh.nakhes')
        .selectAll()
        .where('id', '=', item.nakhId)
        .executeTakeFirstOrThrow();
      expect((await store.purgeNext(item.lease)).purgedRows).toBeGreaterThan(0);
      expect(await facts(item.lease)).toEqual(original);
      const run = await reconcile();
      expect(
        await database
          .selectFrom('billing.reconciliation_anomalies')
          .select('id')
          .where('run_id', '=', run)
          .execute(),
      ).toEqual([]);
      await expect(
        new PostgresCreditLedgerStore(database).append({
          transactionId: randomUUID(),
          userId: item.lease.userId,
          transactionType: 'spend_nakh',
          amount: -2n,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          reference: { nakhId: item.nakhId },
        }),
      ).rejects.toMatchObject({ code: 'capability_denied' });
      await expect(
        database
          .insertInto('nakh.nakhes')
          .values({ ...originalSource, id: randomUUID() })
          .execute(),
      ).rejects.toMatchObject({ code: '23514', message: 'archived Nakh funding cannot be reused' });
      if (item.replayFunding !== undefined)
        for (const replay of await Promise.all(
          Array.from({ length: 20 }, () => item.replayFunding!()),
        ))
          expect(replay).toMatchObject({
            outcome: 'fulfilled',
            nakhId: item.nakhId,
            replayed: true,
          });
      expect(await facts(item.lease)).toEqual(original);
    },
  );
  it('keeps history/source during a partial batch and denies receipt reuse in another transaction', async () => {
    const item = await scene(205);
    expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 100, hasMore: true });
    const before = await ordinary(item.nakhId);
    expect(before).toMatchObject({ source: { version: 3 } });
    expect(
      (
        await sql<{ count: number }>`SELECT count(*)::integer AS count
        FROM nakh.nakh_status_history WHERE nakh_id=${item.nakhId}::uuid`.execute(database)
      ).rows,
    ).toEqual([{ count: 3 }]);
    for (const query of [
      sql`DELETE FROM nakh.nakh_receiver_actions WHERE nakh_id=${item.nakhId}::uuid`,
      sql`DELETE FROM nakh.nakh_status_history WHERE nakh_id=${item.nakhId}::uuid`,
      sql`DELETE FROM nakh.nakhes WHERE id=${item.nakhId}::uuid`,
      sql`UPDATE identity.account_deletion_nakh_receipts SET source_version=1 WHERE nakh_id=${item.nakhId}::uuid`,
    ]) {
      await expect(query.execute(database)).rejects.toMatchObject({ code: '55000' });
      expect(await ordinary(item.nakhId)).toEqual(before);
    }
    while ((await store.purgeNext(item.lease)).hasMore) {
      /* resume the same source */
    }
  });
  it('rejects forged lease/root/life/phase fields before changing ordinary or retained facts', async () => {
    const item = await scene(),
      source = await ordinary(item.nakhId),
      original = await facts(item.lease);
    for (const changed of [
      { deletionRecordId: randomUUID() },
      { userId: randomUUID() },
      { leaseOwner: randomUUID() },
      { leaseGeneration: item.lease.leaseGeneration + 1 },
      { checkpointVersion: 2 },
      { phase: 'evidence_capture' },
    ] as const) {
      await expect(store.purgeNext({ ...item.lease, ...changed })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(await ordinary(item.nakhId)).toEqual(source);
      expect(await facts(item.lease)).toEqual(original);
    }
  });
  it('rolls back actual final removal when the lease expires at deferred commit', async () => {
    const item = await scene(0, 'credits', false, 2000),
      source = await ordinary(item.nakhId),
      original = await facts(item.lease);
    await expect(
      database.transaction().execute(async (tx) => {
        const result = await sql<{
          removed: number;
        }>`SELECT purged_rows AS removed FROM nakh.purge_deletion_funded_source(
        ${item.lease.deletionRecordId}::uuid,${item.lease.userId}::uuid,${item.lease.leaseOwner}::uuid,${item.lease.leaseGeneration})`.execute(
          tx,
        );
        expect(result.rows[0]!.removed).toBeGreaterThan(0);
        await sql`SELECT pg_sleep(2.1)`.execute(tx);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await ordinary(item.nakhId)).toEqual(source);
    expect(await facts(item.lease)).toEqual(original);
  });
  it.each(['platform.audit_logs', 'platform.outbox_events'] as const)(
    'rolls back all removals when the mandatory %s insert is suppressed',
    async (table) => {
      const item = await scene(),
        source = await ordinary(item.nakhId),
        original = await facts(item.lease);
      await sql`CREATE FUNCTION identity.m8_nakh_suppress_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event_type='account.deletion-nakh-batch.v1' THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER m8_nakh_suppress_write BEFORE INSERT ON ${sql.table(table)}
        FOR EACH ROW EXECUTE FUNCTION identity.m8_nakh_suppress_write()`.execute(database);
      try {
        await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await ordinary(item.nakhId)).toEqual(source);
        expect(await facts(item.lease)).toEqual(original);
      } finally {
        await sql`DROP TRIGGER m8_nakh_suppress_write ON ${sql.table(table)}`.execute(database);
        await sql`DROP FUNCTION identity.m8_nakh_suppress_write()`.execute(database);
      }
    },
  );
  it('requires the mandatory event at actual deferred commit, after successful removal', async () => {
    const item = await scene(),
      source = await ordinary(item.nakhId),
      original = await facts(item.lease);
    await expect(
      database.transaction().execute(async (tx) => {
        const result = await sql<{
          removed: number;
        }>`SELECT purged_rows AS removed FROM nakh.purge_deletion_funded_source(
        ${item.lease.deletionRecordId}::uuid,${item.lease.userId}::uuid,${item.lease.leaseOwner}::uuid,${item.lease.leaseGeneration})`.execute(
          tx,
        );
        expect(result.rows[0]!.removed).toBeGreaterThan(0);
        const erased = await tx
          .deleteFrom('platform.outbox_events')
          .where('aggregate_id', '=', item.lease.deletionRecordId)
          .where('event_type', '=', 'account.deletion-nakh-batch.v1')
          .returning('id')
          .execute();
        expect(erased).toHaveLength(1);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await ordinary(item.nakhId)).toEqual(source);
    expect(await facts(item.lease)).toEqual(original);
  });
  it.each(['credit-life', 'reference-life', 'missing-reference'] as const)(
    'keeps archived funding visible and unhealthy across repeated %s scans',
    async (fault) => {
      const item = await scene(),
        original = await facts(item.lease);
      await store.purgeNext(item.lease);
      const anchor = await database
        .selectFrom('nakh.nakh_reference_anchors')
        .selectAll()
        .where('id', '=', item.nakhId)
        .executeTakeFirstOrThrow();
      const credit = await database
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('nakh_id', '=', item.nakhId)
        .executeTakeFirstOrThrow();
      const mutate = async (restore: boolean): Promise<void> =>
        database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            if (restore) {
              await connection
                .insertInto('nakh.nakh_reference_anchors')
                .values(anchor)
                .onConflict((conflict) => conflict.column('id').doUpdateSet(anchor))
                .execute();
              await connection
                .updateTable('billing.credit_transactions')
                .set({ product_epoch: credit.product_epoch })
                .where('id', '=', credit.id)
                .execute();
            } else if (fault === 'credit-life') {
              await connection
                .updateTable('billing.credit_transactions')
                .set({ product_epoch: credit.product_epoch + 1 })
                .where('id', '=', credit.id)
                .execute();
            } else if (fault === 'reference-life') {
              await connection
                .updateTable('nakh.nakh_reference_anchors')
                .set({ receiver_product_epoch: anchor.receiver_product_epoch + 1 })
                .where('id', '=', anchor.id)
                .execute();
            } else
              await connection
                .deleteFrom('nakh.nakh_reference_anchors')
                .where('id', '=', anchor.id)
                .execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      await mutate(false);
      try {
        for (let index = 0; index < 2; index++) {
          await reconcile();
          expect(
            (await new PostgresNakhOperationalMetricsStore(database).measure())
              .fundingInvariantMismatchCount,
          ).toBe(1);
        }
        expect(
          await database
            .selectFrom('billing.reconciliation_anomalies')
            .select('id')
            .where('entity_id', '=', item.nakhId)
            .where('anomaly_type', '=', 'delivered_nakh_funding_proof_invalid')
            .execute(),
        ).toHaveLength(1);
      } finally {
        await mutate(true);
      }
      await reconcile();
      expect(
        (await new PostgresNakhOperationalMetricsStore(database).measure())
          .fundingInvariantMismatchCount,
      ).toBe(0);
      expect(await facts(item.lease)).toEqual(original);
    },
  );
});
