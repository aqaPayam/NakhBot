import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SettlePendingNakhesHandler, type AccountDeletionLease } from '@nakh/application';
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
import { PostgresAccountDeletionPaidPendingStore } from './account-deletion-paid-pending-store.js';
import { PostgresAccountDeletionTerminalPendingStore } from './account-deletion-terminal-pending-store.js';
import { PostgresAccountDeletionFlowStore } from './account-deletion-flow-store.js';
import { PostgresNakhMaintenanceStore } from './nakh-maintenance-store.js';
import { PostgresDirectNakhStore } from './direct-nakh-store.js';
import { PostgresDeliveredNakhStore } from './delivered-nakh-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';
import { PostgresPendingNakhSettlementStore } from './pending-nakh-settlement-store.js';
import { PostgresFundingStore } from './funding-store.js';
import { PostgresTelegramStarsReceiptStore } from './payment-receipt-store.js';
import { PostgresNakhReconciliationStore } from './nakh-reconciliation-store.js';
import { PostgresNakhOperationalMetricsStore } from './nakh-operational-metrics-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 bounded original funded Nakh archival', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionNakhStore;
  async function migrateThrough(last: number): Promise<void> {
    const temporaryRoot = resolve(tmpdir());
    const directory = resolve(await mkdtemp(join(temporaryRoot, 'm8-paid114-')));
    if (!directory.startsWith(`${temporaryRoot}${sep}`))
      throw new Error('Unsafe migration temporary path');
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= last)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(isolated.url, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_nakh_archive');
    await migrateThrough(113);
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionNakhStore(database);
    const historical = await scene(
      0,
      'pending_credits',
      false,
      120000,
      false,
      4,
      async (item) => {
        const subject = { userId: item.userId, deletionRecordId: item.recordId },
          before = await facts(subject);
        await migrateThrough(114);
        await migrateThrough(114);
        expect(await facts(subject)).toEqual(before);
        expect(
          (
            await sql`SELECT id FROM identity.account_deletion_paid_pending_receipts`.execute(
              database,
            )
          ).rows,
        ).toEqual([]);
      },
      archiveHistoricalProfile,
    );
    await sql`SELECT * FROM nakh.purge_deletion_funded_source(${historical.lease.deletionRecordId}::uuid,
      ${historical.lease.userId}::uuid,${historical.lease.leaseOwner}::uuid,${historical.lease.leaseGeneration})`.execute(
      database,
    );
    const before = await facts(historical.lease);
    delete before.pending;
    expect(
      (
        await sql`SELECT purged_rows AS "purgedRows",has_more AS "hasMore"
        FROM nakh.purge_deletion_paid_pending_source(${historical.lease.deletionRecordId}::uuid,
          ${historical.lease.userId}::uuid,${historical.lease.leaseOwner}::uuid,${historical.lease.leaseGeneration})`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ purgedRows: 1, hasMore: false }]);
    const after = await facts(historical.lease);
    delete after.pending;
    expect(after).toEqual(before);
    expect(
      (
        await sql<{
          valid: boolean;
          version: number;
        }>`SELECT nakh.original_pending_reference_valid(id) AS valid,version
      FROM nakh.pending_nakh_lifecycle_facts WHERE id=${historical.pendingNakhId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true, version: 6 }]);
    const terminal = await terminalScene(
      'closed_by_system',
      'sender',
      120000,
      archiveHistoricalProfile,
    );
    const paidBefore = await facts(historical.lease),
      terminalBefore = await facts(terminal.lease);
    const paidReceiptBefore = (
      await sql`SELECT to_jsonb(receipt) AS receipt
      FROM identity.account_deletion_paid_pending_receipts receipt`.execute(database)
    ).rows;
    await runMigrations(isolated.url, resolve('migrations'));
    await runMigrations(isolated.url, resolve('migrations'));
    const verified = await verifyMigrations(isolated.url, resolve('migrations/verify'));
    expect(verified).toContain('000115_m8_terminal_pending_archival.sql');
    expect(verified).toContain('000116_m8_flow_references.sql');
    expect(await facts(historical.lease)).toEqual(paidBefore);
    expect(await facts(terminal.lease)).toEqual(terminalBefore);
    expect(
      (
        await sql`SELECT to_jsonb(receipt) AS receipt FROM identity.account_deletion_paid_pending_receipts receipt`.execute(
          database,
        )
      ).rows,
    ).toEqual(paidReceiptBefore);
    expect(
      (
        await sql`SELECT id FROM identity.account_deletion_terminal_pending_receipts`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    expect(
      await new PostgresAccountDeletionTerminalPendingStore(database).purgeNext(terminal.lease),
    ).toEqual({ purgedRows: 1, hasMore: false });
    expect(
      (
        await sql`SELECT id,version,nakh.original_pending_reference_valid(id) AS valid
      FROM nakh.pending_nakh_lifecycle_facts WHERE id IN (${historical.pendingNakhId}::uuid,${terminal.pendingId}::uuid)
      ORDER BY id`.execute(database)
      ).rows,
    ).toEqual(
      [
        { id: historical.pendingNakhId, version: 6, valid: true },
        { id: terminal.pendingId, version: 6, valid: true },
      ].sort((a, b) => a.id!.localeCompare(b.id!)),
    );
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
  // Seed the historical schema through its real protected receipt/body writes.
  // The current store correctly rejects a pre-115 catalog; no catalog allowance
  // or trigger bypass is used to manufacture this populated upgrade baseline.
  async function archiveHistoricalProfile(
    lease: AccountDeletionLease,
  ): Promise<{ archived: boolean }> {
    return work.withLease(lease, async (tx, scope) => {
      const profile = (
        await sql<{
          id: string;
        }>`SELECT id FROM profile.profiles WHERE user_id=${scope.userId}::uuid FOR UPDATE`.execute(
          tx,
        )
      ).rows[0]!;
      expect(
        (
          await sql<{
            ready: boolean;
          }>`SELECT identity.profile_captures_verified(${scope.deletionRecordId}::uuid,${profile.id}::uuid) AS ready`.execute(
            tx,
          )
        ).rows,
      ).toEqual([{ ready: true }]);
      const facts = (
        await sql<{
          command_id: string;
          request_id: string;
          at: string;
        }>`SELECT command_id,request_id,clock_timestamp()::text AS at
        FROM identity.account_deletion_records WHERE id=${scope.deletionRecordId}::uuid`.execute(tx)
      ).rows[0]!;
      const auditId = randomUUID(),
        eventId = randomUUID();
      const audit =
        await sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,
        result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
        VALUES(${auditId}::uuid,'account','account.deletion-profile-archived.v1','system','account_deletion',
          ${scope.deletionRecordId}::uuid,'profile_archived',1,'{"kind":"profile_source"}'::jsonb,
          ${facts.command_id}::uuid,${facts.request_id}::uuid,${facts.at}) RETURNING id`.execute(
          tx,
        );
      const event =
        await sql`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,
        payload,occurred_at,available_at,correlation_id,causation_id)
        VALUES(${eventId}::uuid,'account_deletion',${scope.deletionRecordId}::uuid,'account.deletion-profile-archived.v1',1,
          jsonb_build_object('deletionRecordId',${scope.deletionRecordId}::uuid,'kind','profile_source'),${facts.at},${facts.at},
          ${facts.request_id}::uuid,${facts.command_id}::uuid) RETURNING id`.execute(tx);
      const receipt =
        await sql`INSERT INTO identity.account_deletion_profile_receipts(deletion_record_id,profile_id,
        checklist_version,lease_owner,lease_generation,lease_expires_at,archived_at,audit_id,event_id)
        VALUES(${scope.deletionRecordId}::uuid,${profile.id}::uuid,1,${scope.leaseOwner}::uuid,${scope.leaseGeneration},
          (SELECT lease_expires_at FROM identity.account_deletion_work WHERE deletion_record_id=${scope.deletionRecordId}::uuid),
          ${facts.at},${auditId}::uuid,${eventId}::uuid) RETURNING profile_id`.execute(tx);
      const removed =
        await sql`DELETE FROM profile.profiles WHERE id=${profile.id}::uuid AND user_id=${scope.userId}::uuid RETURNING id`.execute(
          tx,
        );
      for (const result of [audit, event, receipt, removed]) expect(result.rows).toHaveLength(1);
      return { archived: true };
    });
  }
  async function scene(
    actions = 0,
    funding: 'credits' | 'pending_credits' | 'telegram_stars' = 'credits',
    accepted = false,
    leaseMs = 120000,
    prepareLateCapture = false,
    pendingEdits = 0,
    beforeShared?: (item: { userId: string; recordId: string }) => Promise<void>,
    archiveProfile?: (lease: AccountDeletionLease) => Promise<{ archived: boolean }>,
  ): Promise<{
    lease: AccountDeletionLease;
    nakhId: string;
    receiver: string;
    replayFunding: (() => Promise<unknown>) | undefined;
    pendingNakhId: string | undefined;
    lateCapture:
      | Readonly<{
          paymentRecordId: string;
          telegramChargeId: string;
          starsAmount: bigint;
          submit: () => ReturnType<PostgresTelegramStarsReceiptStore['recordSuccessfulPayment']>;
        }>
      | undefined;
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
    let pendingNakhId: string | undefined;
    let lateCapture:
      | Readonly<{
          paymentRecordId: string;
          telegramChargeId: string;
          starsAmount: bigint;
          submit: () => ReturnType<PostgresTelegramStarsReceiptStore['recordSuccessfulPayment']>;
        }>
      | undefined;
    const item = await createDeletionFixture(database, async (sender) => {
      if (prepareLateCapture)
        await sql`UPDATE identity.guest_preview_counters SET preview_count=LEAST(limit_count,3),
          first_preview_at=${at},last_preview_at=${at} WHERE user_id=${sender}::uuid`.execute(
          database,
        );
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
        pendingNakhId = pending.pendingNakhId;
        if (prepareLateCapture) {
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
              keyId: 'm8-late-test',
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
          const providerEventId = randomUUID(),
            telegramChargeId = `synthetic:${randomUUID()}`;
          const evidence = {
            digest: digest(providerEventId),
            ciphertext: randomBytes(64),
            keyId: 'm8-late-test',
            schemaVersion: 1,
          };
          lateCapture = {
            paymentRecordId: attempt.paymentRecordId,
            telegramChargeId,
            starsAmount: attempt.starsAmount,
            submit: () =>
              receipts.recordSuccessfulPayment({
                providerEventId,
                telegramUserId: identity.telegram_user_id,
                invoicePayload: cleartext,
                currency: 'XTR',
                totalAmount: attempt.starsAmount,
                providerEnvironment: 'test',
                providerBotIdDigest: 'b'.repeat(64),
                telegramChargeId,
                evidence,
              }),
          };
        }
        for (let edit = 0; edit < pendingEdits; edit++)
          await sql`UPDATE nakh.pending_nakhes SET text=text || 'x',version=version+1
            WHERE id=${pending.pendingNakhId}::uuid`.execute(database);
        if (funding === 'pending_credits') {
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
          const pendingSource = await database
            .selectFrom('nakh.pending_nakhes')
            .select('nakh_flow_id')
            .where('id', '=', pending.pendingNakhId)
            .executeTakeFirstOrThrow();
          nakhId = (
            await database
              .selectFrom('nakh.nakhes')
              .select('id')
              .where('nakh_flow_id', '=', pendingSource.nakh_flow_id)
              .executeTakeFirstOrThrow()
          ).id;
        } else {
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
    await beforeShared?.(item);
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
    expect(
      await (archiveProfile?.(evidence) ??
        new PostgresAccountDeletionProfileStore(database).archive(evidence)),
    ).toMatchObject({ archived: true });
    expect(await checkpoints.finishEvidence(evidence)).toMatchObject({
      phase: 'product_data',
      checkpointVersion: 3,
    });
    const lease = await claim(leaseMs);
    expect(lease.deletionRecordId).toBe(item.recordId);
    return { lease, nakhId, receiver, replayFunding, pendingNakhId, lateCapture };
  }
  async function facts(
    lease: Pick<AccountDeletionLease, 'userId' | 'deletionRecordId'>,
  ): Promise<Record<string, unknown>> {
    return (
      await sql<{ facts: Record<string, unknown> }>`SELECT jsonb_build_object(
      'credits',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.credit_transactions row),
      'payments',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.payment_records row),
      'provider',(SELECT jsonb_agg(to_jsonb(row) ORDER BY payment_record_id) FROM billing.telegram_stars_receipts row),
      'fulfillments',(SELECT jsonb_agg(to_jsonb(row) ORDER BY payment_record_id) FROM billing.payment_fulfillments row),
      'intents',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.pending_payments row),
      'refunds',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.refund_records row),
      'providerEvents',(SELECT jsonb_agg(to_jsonb(row) ORDER BY provider,provider_event_id) FROM billing.payment_provider_events row),
      'pending',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.pending_nakhes row),
      'pendingAnchors',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.pending_nakh_reference_anchors row),
      'counters',(SELECT jsonb_agg(to_jsonb(row) ORDER BY user_id) FROM platform.user_counters row),
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
  async function retainedFlowFacts(): Promise<unknown> {
    return (
      await sql<{ facts: unknown }>`SELECT jsonb_build_object(
      'credits',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.credit_transactions row),
      'payments',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.payment_records row),
      'intents',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.pending_payments row),
      'refunds',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM billing.refund_records row),
      'accounts',(SELECT jsonb_agg(to_jsonb(row) ORDER BY user_id) FROM identity.accounts row),
      'roots',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM identity.account_deletion_records row),
      'preview',(SELECT jsonb_agg(to_jsonb(row) ORDER BY user_id) FROM identity.guest_preview_counters row),
      'flows',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM nakh.flow_reference_anchors row)) AS facts`.execute(
        database,
      )
    ).rows[0]!.facts;
  }
  it('serializes both original participant roots into one Flow removal', async () => {
    const item = await scene();
    await store.purgeNext(item.lease);
    const key = randomBytes(32),
      deletion = new PostgresAccountDeletionStore(database, {
        activeKeyId: 'm8-flow-dual',
        keys: new Map([['m8-flow-dual', key]]),
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
      const id = randomUUID();
      await deletion.request({
        commandId: id,
        commandType: 'account.delete',
        schemaVersion: 1,
        actor: { kind: 'user', userId: item.receiver },
        requestId: randomUUID(),
        idempotencyKey: id,
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
    const shared = await claim(),
      closure = new PostgresAccountDeletionSharedStore(database);
    while ((await closure.closeNext(shared)).hasMore) {
      /* second original participant */
    }
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(shared);
    const evidence = await claim();
    await new PostgresAccountDeletionProfileStore(database).archive(evidence);
    expect(await checkpoints.finishEvidence(evidence)).toMatchObject({ phase: 'product_data' });
    const counterpart = await claim();
    expect(counterpart.userId).toBe(item.receiver);
    const before = await retainedFlowFacts(),
      flows = new PostgresAccountDeletionFlowStore(database);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        flows.purgeNext(index % 2 === 0 ? item.lease : counterpart),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.purgedRows, 0)).toBe(1);
    expect(results.every((result) => !result.hasMore)).toBe(true);
    expect(await retainedFlowFacts()).toEqual(before);
    expect(await flows.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
    expect(await flows.purgeNext(counterpart)).toEqual({ purgedRows: 0, hasMore: false });
  });
  it.each([
    'identity.account_deletion_flow_receipts',
    'platform.audit_logs',
    'platform.outbox_events',
    'nakh.nakh_flows',
  ] as const)('rolls back Flow archival if required %s writing is suppressed', async (table) => {
    const item = await scene();
    await store.purgeNext(item.lease);
    const reference = await database
      .selectFrom('nakh.nakh_reference_anchors')
      .selectAll()
      .where('id', '=', item.nakhId)
      .executeTakeFirstOrThrow();
    const before = await retainedFlowFacts();
    await sql`CREATE FUNCTION identity.m8_flow_suppress_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF TG_TABLE_NAME IN ('account_deletion_flow_receipts','nakh_flows') THEN RETURN NULL;
        ELSIF NEW.event_type='account.deletion-flow-batch.v1' THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER m8_flow_suppress_test BEFORE ${sql.raw(table === 'nakh.nakh_flows' ? 'DELETE' : 'INSERT')}
        ON ${sql.table(table)} FOR EACH ROW EXECUTE FUNCTION identity.m8_flow_suppress_test()`.execute(
      database,
    );
    try {
      await expect(
        new PostgresAccountDeletionFlowStore(database).purgeNext(item.lease),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(await retainedFlowFacts()).toEqual(before);
      expect(
        (
          await sql`SELECT id FROM nakh.nakh_flows WHERE id=${reference.nakh_flow_id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await sql`SELECT id FROM identity.account_deletion_flow_receipts WHERE flow_id=${reference.nakh_flow_id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await sql`DROP TRIGGER m8_flow_suppress_test ON ${sql.table(table)}`.execute(database);
      await sql`DROP FUNCTION identity.m8_flow_suppress_test()`.execute(database);
    }
    expect(await new PostgresAccountDeletionFlowStore(database).purgeNext(item.lease)).toEqual({
      purgedRows: 1,
      hasMore: false,
    });
  });
  it('denies forged Flow leases and ordinary mutation without changing original proof', async () => {
    const item = await scene();
    await store.purgeNext(item.lease);
    const reference = await database
      .selectFrom('nakh.nakh_reference_anchors')
      .selectAll()
      .where('id', '=', item.nakhId)
      .executeTakeFirstOrThrow();
    const before = await retainedFlowFacts(),
      flows = new PostgresAccountDeletionFlowStore(database);
    for (const change of [
      { deletionRecordId: randomUUID() },
      { userId: randomUUID() },
      { leaseOwner: randomUUID() },
      { leaseGeneration: item.lease.leaseGeneration + 1 },
      { checkpointVersion: 2 },
      { phase: 'evidence_capture' },
    ] as const)
      await expect(flows.purgeNext({ ...item.lease, ...change })).rejects.toMatchObject({
        code: 'conflict',
      });
    await expect(
      sql`DELETE FROM nakh.nakh_flows WHERE id=${reference.nakh_flow_id}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await retainedFlowFacts()).toEqual(before);
  });
  it('rolls back Flow removal when the worker expires at actual deferred commit', async () => {
    const item = await scene();
    await store.purgeNext(item.lease);
    await work.release(item.lease);
    const lease = await claim(2000),
      before = await retainedFlowFacts();
    await expect(
      database.transaction().execute(async (tx) => {
        expect(
          (
            await sql<{
              rows: number;
            }>`SELECT purged_rows AS rows FROM nakh.purge_deletion_flow_source(
        ${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration})`.execute(
              tx,
            )
          ).rows,
        ).toEqual([{ rows: 1 }]);
        await sql`SELECT pg_sleep(2.1)`.execute(tx);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await retainedFlowFacts()).toEqual(before);
  });
  it.each(['audit', 'missing-receipt', 'transaction'] as const)(
    'keeps archived Flow %s corruption visible and rejects empty replay',
    async (fault) => {
      const item = await scene();
      await store.purgeNext(item.lease);
      const flows = new PostgresAccountDeletionFlowStore(database);
      expect(await flows.purgeNext(item.lease)).toEqual({ purgedRows: 1, hasMore: false });
      const receipt = (
        await sql<{
          saved: Record<string, unknown>;
          flowId: string;
          auditId: string;
        }>`SELECT to_jsonb(receipt) AS saved,
      flow_id AS "flowId",audit_id AS "auditId" FROM identity.account_deletion_flow_receipts receipt WHERE deletion_record_id=${item.lease.deletionRecordId}::uuid`.execute(
          database,
        )
      ).rows[0]!;
      const audit = await database
        .selectFrom('platform.audit_logs')
        .select('metadata')
        .where('id', '=', receipt.auditId)
        .executeTakeFirstOrThrow();
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          if (fault === 'audit')
            await connection
              .updateTable('platform.audit_logs')
              .set({ metadata: { kind: 'flow_source', rows: 1, receiptDigest: '0'.repeat(64) } })
              .where('id', '=', receipt.auditId)
              .execute();
          else if (fault === 'missing-receipt')
            await sql`DELETE FROM identity.account_deletion_flow_receipts WHERE flow_id=${receipt.flowId}::uuid`.execute(
              connection,
            );
          else
            await sql`UPDATE identity.account_deletion_flow_receipts SET batch_transaction=pg_current_xact_id() WHERE flow_id=${receipt.flowId}::uuid`.execute(
              connection,
            );
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
      try {
        expect(
          (
            await sql<{
              shape_valid: boolean;
            }>`SELECT shape_valid FROM nakh.flow_lifecycle_facts WHERE id=${receipt.flowId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ shape_valid: false }]);
        await expect(flows.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
        await reconcile();
        expect(
          (await new PostgresNakhOperationalMetricsStore(database).measure())
            .fundingInvariantMismatchCount,
        ).toBe(1);
      } finally {
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            await sql`DELETE FROM identity.account_deletion_flow_receipts WHERE flow_id=${receipt.flowId}::uuid`.execute(
              connection,
            );
            await sql`INSERT INTO identity.account_deletion_flow_receipts SELECT restored.* FROM jsonb_populate_record(
            NULL::identity.account_deletion_flow_receipts,${JSON.stringify(receipt.saved)}::jsonb) restored`.execute(
              connection,
            );
            await connection
              .updateTable('platform.audit_logs')
              .set({ metadata: audit.metadata })
              .where('id', '=', receipt.auditId)
              .execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      }
      expect(await flows.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
      await reconcile();
      expect(
        (await new PostgresNakhOperationalMetricsStore(database).measure())
          .fundingInvariantMismatchCount,
      ).toBe(0);
    },
  );
  it.each(['credits', 'pending_credits', 'telegram_stars'] as const)(
    'archives original %s Flow once under twenty retries while keeping original financial replay',
    async (funding) => {
      const item = await scene(0, funding, false, 120000, funding !== 'credits');
      const reference = await database
        .selectFrom('nakh.nakh_reference_anchors')
        .selectAll()
        .where('id', '=', item.nakhId)
        .executeTakeFirstOrThrow();
      const flows = new PostgresAccountDeletionFlowStore(database);
      await expect(flows.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      while ((await store.purgeNext(item.lease)).hasMore) {
        /* bounded original body archival */
      }
      if (item.pendingNakhId)
        expect(
          await new PostgresAccountDeletionPaidPendingStore(database).purgeNext(item.lease),
        ).toEqual({ purgedRows: 1, hasMore: false });
      const before = await retainedFlowFacts();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => flows.purgeNext(item.lease)),
      );
      expect(results.reduce((sum, result) => sum + result.purgedRows, 0)).toBe(1);
      expect(results.every((result) => !result.hasMore)).toBe(true);
      expect(await retainedFlowFacts()).toEqual(before);
      expect(
        (
          await sql<{
            id: string;
            shape_valid: boolean;
          }>`SELECT id,shape_valid FROM nakh.flow_lifecycle_facts WHERE id=${reference.nakh_flow_id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ id: reference.nakh_flow_id, shape_valid: true }]);
      expect(
        (
          await sql`SELECT id FROM nakh.nakh_flows WHERE id=${reference.nakh_flow_id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
      await expect(
        database
          .insertInto('nakh.nakh_flows')
          .values({
            id: reference.nakh_flow_id,
            sender_user_id: reference.sender_user_id,
            receiver_user_id: reference.receiver_user_id,
          })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        (
          await sql`SELECT id FROM identity.account_deletion_flow_receipts WHERE flow_id=${reference.nakh_flow_id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toHaveLength(1);
      if (item.replayFunding)
        for (const result of await Promise.all(Array.from({ length: 20 }, item.replayFunding)))
          expect(result).toMatchObject({
            outcome: 'fulfilled',
            nakhId: item.nakhId,
            replayed: true,
          });
      if (item.lateCapture) {
        for (const result of await Promise.all(Array.from({ length: 20 }, item.lateCapture.submit)))
          expect(['receipt_recorded', 'replayed']).toContain(result.outcome);
        expect(
          (
            await sql`SELECT id FROM billing.refund_records WHERE payment_record_id=${item.lateCapture.paymentRecordId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toHaveLength(1);
      }
      await reconcile();
      expect(
        (await new PostgresNakhOperationalMetricsStore(database).measure())
          .fundingInvariantMismatchCount,
      ).toBe(0);
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
    },
  );
  it.each(['closed_by_system', 'expired', 'cancel_like'] as const)(
    'archives terminal %s Flow without restoring its body or losing the original late refund',
    async (status) => {
      const item = await terminalScene(status, 'sender', 120000);
      const reference = await database
        .selectFrom('nakh.pending_nakh_reference_anchors')
        .selectAll()
        .where('id', '=', item.pendingId)
        .executeTakeFirstOrThrow();
      const flows = new PostgresAccountDeletionFlowStore(database);
      await expect(flows.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      expect(
        await new PostgresAccountDeletionTerminalPendingStore(database).purgeNext(item.lease),
      ).toEqual({ purgedRows: 1, hasMore: false });
      const before = await retainedFlowFacts();
      expect(await flows.purgeNext(item.lease)).toEqual({ purgedRows: 1, hasMore: false });
      expect(await flows.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
      expect(await retainedFlowFacts()).toEqual(before);
      for (const result of await Promise.all(Array.from({ length: 20 }, item.submit)))
        expect(['receipt_recorded', 'replayed']).toContain(result.outcome);
      expect(
        (
          await sql`SELECT id FROM billing.refund_records WHERE payment_record_id=${item.paymentId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await sql<{
            valid: boolean;
          }>`SELECT nakh.original_flow_reference_valid(${reference.nakh_flow_id}::uuid) AS valid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ valid: true }]);
      expect(await flows.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
    },
  );
  async function terminalScene(
    status: 'closed_by_system' | 'cancel_like' | 'cancel_not_interested' | 'expired',
    role: 'sender' | 'receiver' = 'sender',
    leaseMs = 120000,
    archiveProfile?: (lease: AccountDeletionLease) => Promise<{ archived: boolean }>,
    captureBeforeExpiry = false,
  ): Promise<{
    lease: AccountDeletionLease;
    pendingId: string;
    paymentId: string;
    sender: string;
    charge: string;
    submit: () => ReturnType<PostgresTelegramStarsReceiptStore['recordSuccessfulPayment']>;
  }> {
    const other = await createReportUser(database, true),
      at = new Date();
    for (const table of [
      'identity.user_settings',
      'billing.credit_accounts',
      'notification.notification_preferences',
    ] as const)
      await database
        .insertInto(table)
        .values({ user_id: other, created_at: at, updated_at: at })
        .execute();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: other,
        telegram_user_id: String(9_000_000_000_000 + Math.floor(Math.random() * 100_000_000)),
        first_seen_at: at,
        last_seen_at: at,
      })
      .execute();
    let pendingId!: string,
      paymentId!: string,
      sender!: string,
      submit!: () => ReturnType<PostgresTelegramStarsReceiptStore['recordSuccessfulPayment']>;
    const charge = `synthetic:${randomUUID()}`,
      digest = (value: string): string => createHash('sha256').update(value).digest('hex');
    const fixture = await createDeletionFixture(database, async (owner) => {
      const template = await database
        .selectFrom('profile.profiles')
        .selectAll()
        .where('user_id', '=', other)
        .executeTakeFirstOrThrow();
      await database
        .insertInto('profile.profiles')
        .values({ ...template, id: randomUUID(), user_id: owner })
        .execute();
      await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp()
        WHERE user_id=${owner}::uuid`.execute(database);
      await sql`UPDATE identity.guest_preview_counters SET preview_count=3,first_preview_at=${at},last_preview_at=${at}
        WHERE user_id=${owner}::uuid`.execute(database);
      sender = role === 'sender' ? owner : other;
      const receiver = role === 'receiver' ? owner : other;
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
            text: 'Private unpaid terminal body',
            autoSettleAuthorized: true,
          },
        },
        flowId: randomUUID(),
        pendingNakhId: randomUUID(),
        pendingPaymentId: randomUUID(),
        flowEventId: randomUUID(),
        pendingEventId: randomUUID(),
      });
      pendingId = pending.pendingNakhId;
      const cleartext = randomBytes(24).toString('base64url');
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
          keyId: 'm8-terminal-test',
        },
      });
      paymentId = attempt.paymentRecordId;
      const identity = await database
        .selectFrom('identity.telegram_identities')
        .select('telegram_user_id')
        .where('user_id', '=', sender)
        .executeTakeFirstOrThrow();
      const receipts = new PostgresTelegramStarsReceiptStore(
        database,
        { uuid: randomUUID },
        { digest },
      );
      const providerEventId = randomUUID(),
        evidence = {
          digest: digest(providerEventId),
          ciphertext: randomBytes(64),
          keyId: 'm8-terminal-test',
          schemaVersion: 1,
        };
      submit = () =>
        receipts.recordSuccessfulPayment({
          providerEventId,
          telegramUserId: identity.telegram_user_id,
          invoicePayload: cleartext,
          currency: 'XTR',
          totalAmount: attempt.starsAmount,
          providerEnvironment: 'test',
          providerBotIdDigest: 'b'.repeat(64),
          telegramChargeId: charge,
          evidence,
        });
      for (let edit = 0; edit < 4; edit++)
        await sql`UPDATE nakh.pending_nakhes SET text=text || 'x',version=version+1
        WHERE id=${pendingId}::uuid`.execute(database);
      if (status === 'expired') {
        // A synthetic historical clock fixture; expiry and late callbacks use
        // their actual public stores. This does not claim fourteen elapsed days.
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            if (captureBeforeExpiry) {
              // Shorten the synthetic fixture's clock, then use actual admission,
              // database-clock expiry and worker correction in that order.
              await sql`WITH clock AS (SELECT clock_timestamp()+interval '6 seconds' AS expiry)
                UPDATE nakh.pending_nakhes SET created_at=clock.expiry-interval '336 hours',
                  expires_at=clock.expiry,authorized_at=clock.expiry-interval '336 hours',
                  auto_settle_authorized_at=clock.expiry-interval '336 hours'
                  FROM clock WHERE id=${pendingId}::uuid`.execute(connection);
              await sql`UPDATE billing.pending_payments intent SET created_at=pending.created_at,expires_at=pending.expires_at
                FROM nakh.pending_nakhes pending WHERE pending.id=${pendingId}::uuid AND intent.id=pending.pending_payment_id`.execute(
                connection,
              );
            } else {
              await sql`UPDATE nakh.pending_nakhes SET created_at=created_at-interval '15 days',
              expires_at=expires_at-interval '15 days',authorized_at=authorized_at-interval '15 days',
              auto_settle_authorized_at=auto_settle_authorized_at-interval '15 days'
              WHERE id=${pendingId}::uuid`.execute(connection);
              await sql`UPDATE billing.pending_payments SET created_at=created_at-interval '15 days',expires_at=expires_at-interval '15 days'
              WHERE id=${pending.fundingIntentId}::uuid`.execute(connection);
            }
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
        if (captureBeforeExpiry) {
          expect(await submit()).toMatchObject({ outcome: 'receipt_recorded' });
          expect(
            (
              await sql`SELECT receipt.received_at<pending.expires_at AS "beforeExpiry",fulfillment.state
            FROM nakh.pending_nakhes pending JOIN billing.telegram_stars_receipts receipt ON receipt.payment_record_id=${paymentId}::uuid
            JOIN billing.payment_fulfillments fulfillment ON fulfillment.payment_record_id=receipt.payment_record_id
            WHERE pending.id=${pendingId}::uuid`.execute(database)
            ).rows,
          ).toEqual([{ beforeExpiry: true, state: 'receipt_recorded' }]);
          await sql`SELECT pg_sleep(GREATEST(0,extract(epoch FROM expires_at-clock_timestamp()))+0.05)
            FROM nakh.pending_nakhes WHERE id=${pendingId}::uuid`.execute(database);
        }
        expect(await new PostgresNakhMaintenanceStore(database).expirePending(100)).toMatchObject({
          changed: 1,
        });
        if (captureBeforeExpiry) {
          expect(
            (
              await sql`SELECT identity.deletion_has_unresolved_shared_payments(${sender}::uuid) AS blocked`.execute(
                database,
              )
            ).rows,
          ).toEqual([{ blocked: true }]);
          const owner = `m8-expired-capture:${randomUUID()}`;
          const fulfillment = (
            await receipts.claimFulfillments({ owner, leaseMs: 120000, limit: 100 })
          ).find((row) => row.paymentRecordId === paymentId)!;
          expect(fulfillment).toBeDefined();
          expect(
            await receipts.fulfillPendingNakh({
              paymentRecordId: paymentId,
              owner,
              fenceToken: fulfillment.fenceToken,
              nakhId: randomUUID(),
              historyId: randomUUID(),
              refundRecordId: randomUUID(),
              deliveredEventId: randomUUID(),
              paymentTerminalEventId: randomUUID(),
            }),
          ).toMatchObject({ outcome: 'correction_required', replayed: false });
          expect(
            (
              await sql`SELECT identity.deletion_has_unresolved_shared_payments(${sender}::uuid) AS blocked`.execute(
                database,
              )
            ).rows,
          ).toEqual([{ blocked: false }]);
        }
      } else if (status !== 'closed_by_system') {
        await new PostgresPendingNakhStore(database).cancelPending({
          command: {
            commandId: randomUUID(),
            commandType: 'nakh.cancel-pending',
            schemaVersion: 1,
            actor: { kind: 'user', userId: sender },
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
            locale: 'en',
            data: {
              pendingNakhId: pendingId,
              resolution:
                status === 'cancel_like' ? 'converted_to_like' : 'converted_to_not_interested',
              expectedVersion: 5,
            },
          },
          interactionId: randomUUID(),
          matchId: randomUUID(),
          chatSessionId: randomUUID(),
          interactionEventId: randomUUID(),
          likeClosedEventId: randomUUID(),
          matchEventId: randomUUID(),
          pendingEventId: randomUUID(),
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
    await (archiveProfile?.(evidence) ??
      new PostgresAccountDeletionProfileStore(database).archive(evidence));
    expect(await checkpoints.finishEvidence(evidence)).toMatchObject({
      phase: 'product_data',
      checkpointVersion: 3,
    });
    const lease = await claim(leaseMs);
    expect(lease.deletionRecordId).toBe(fixture.recordId);
    return { lease, pendingId, paymentId, sender, charge, submit };
  }
  it.each(['closed_by_system', 'cancel_like', 'cancel_not_interested', 'expired'] as const)(
    'archives terminal %s once under twenty retries and retains one genuine late refund',
    async (status) => {
      const item = await terminalScene(status),
        terminal = new PostgresAccountDeletionTerminalPendingStore(database);
      const original = await facts(item.lease);
      delete original.pending;
      const source = await database
        .selectFrom('nakh.pending_nakhes')
        .selectAll()
        .where('id', '=', item.pendingId)
        .executeTakeFirstOrThrow();
      expect(source.version).toBe(6);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => terminal.purgeNext(item.lease)),
      );
      expect(results.reduce((sum, row) => sum + row.purgedRows, 0)).toBe(1);
      expect(results.every((row) => !row.hasMore)).toBe(true);
      const after = await facts(item.lease);
      delete after.pending;
      expect(after).toEqual(original);
      expect(
        await database
          .selectFrom('nakh.pending_nakhes')
          .select('id')
          .where('id', '=', item.pendingId)
          .execute(),
      ).toEqual([]);
      const captures = await Promise.all(Array.from({ length: 20 }, () => item.submit()));
      expect(captures.filter((row) => row.outcome === 'receipt_recorded')).toHaveLength(1);
      expect(captures.filter((row) => row.outcome === 'replayed')).toHaveLength(19);
      const refunds = await database
        .selectFrom('billing.refund_records')
        .selectAll()
        .where('payment_record_id', '=', item.paymentId)
        .execute();
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        user_id: item.sender,
        telegram_charge_id: item.charge,
        stars_amount: '2',
        reason_code: 'target_unavailable',
        status: 'pending',
      });
      expect(
        await database
          .selectFrom('nakh.nakhes')
          .select('id')
          .where('sender_user_id', '=', item.sender)
          .execute(),
      ).toEqual([]);
      await reconcile();
      expect(
        (await new PostgresNakhOperationalMetricsStore(database).measure())
          .fundingInvariantMismatchCount,
      ).toBe(0);
      expect(
        (
          await sql<{
            valid: boolean;
            closed: boolean;
          }>`SELECT nakh.original_pending_reference_valid(id) AS valid,
        nakh.terminal_pending_closure_valid(pending) AS closed FROM nakh.pending_nakh_lifecycle_facts pending
        WHERE id=${item.pendingId}::uuid`.execute(database)
        ).rows,
      ).toEqual([{ valid: true, closed: true }]);
    },
  );
  it('overlaps terminal archival with genuine capture without deadlock, new delivery or duplicate refund', async () => {
    const item = await terminalScene('closed_by_system');
    const original = await facts(item.lease);
    const terminal = new PostgresAccountDeletionTerminalPendingStore(database);
    const [archives, captures] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, () => terminal.purgeNext(item.lease))),
      Promise.all(Array.from({ length: 10 }, () => item.submit())),
    ]);
    expect(archives.reduce((sum, row) => sum + row.purgedRows, 0)).toBe(1);
    expect(archives.every((row) => !row.hasMore)).toBe(true);
    expect(captures.filter((row) => row.outcome === 'receipt_recorded')).toHaveLength(1);
    expect(captures.filter((row) => row.outcome === 'replayed')).toHaveLength(9);
    const after = await facts(item.lease);
    for (const key of [
      'credits',
      'intents',
      'pendingAnchors',
      'counters',
      'anchors',
      'flows',
      'account',
      'root',
      'preview',
    ])
      expect(after[key]).toEqual(original[key]);
    expect(
      await database
        .selectFrom('nakh.pending_nakhes')
        .select('id')
        .where('id', '=', item.pendingId)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('nakh.nakhes')
        .select('id')
        .where('sender_user_id', '=', item.sender)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('billing.telegram_stars_receipts')
        .select(['payer_user_id', 'telegram_charge_id', 'stars_amount'])
        .where('payment_record_id', '=', item.paymentId)
        .execute(),
    ).toEqual([{ payer_user_id: item.sender, telegram_charge_id: item.charge, stars_amount: '2' }]);
    expect(
      await database
        .selectFrom('billing.refund_records')
        .select(['user_id', 'telegram_charge_id', 'stars_amount', 'reason_code'])
        .where('payment_record_id', '=', item.paymentId)
        .execute(),
    ).toEqual([
      {
        user_id: item.sender,
        telegram_charge_id: item.charge,
        stars_amount: '2',
        reason_code: 'target_unavailable',
      },
    ]);
    await reconcile();
    expect(
      (await new PostgresNakhOperationalMetricsStore(database).measure())
        .fundingInvariantMismatchCount,
    ).toBe(0);
  });
  it('preserves capture admitted before actual expiry and the delayed worker refund during terminal archival', async () => {
    const item = await terminalScene('expired', 'sender', 120000, undefined, true);
    expect(
      (
        await sql`SELECT pending.status,intent.status AS "intentStatus",fulfillment.state
      FROM nakh.pending_nakhes pending JOIN billing.pending_payments intent ON intent.id=pending.pending_payment_id
      JOIN billing.payment_fulfillments fulfillment ON fulfillment.payment_record_id=${item.paymentId}::uuid
      WHERE pending.id=${item.pendingId}::uuid`.execute(database)
      ).rows,
    ).toEqual([{ status: 'expired', intentStatus: 'paid', state: 'correction_required' }]);
    const original = await facts(item.lease);
    delete original.pending;
    expect(
      await new PostgresAccountDeletionTerminalPendingStore(database).purgeNext(item.lease),
    ).toEqual({ purgedRows: 1, hasMore: false });
    for (const result of await Promise.all(Array.from({ length: 20 }, () => item.submit())))
      expect(result).toMatchObject({ outcome: 'replayed' });
    const after = await facts(item.lease);
    delete after.pending;
    expect(after).toEqual(original);
    expect(
      await database
        .selectFrom('billing.refund_records')
        .select(['user_id', 'telegram_charge_id', 'stars_amount', 'reason_code'])
        .where('payment_record_id', '=', item.paymentId)
        .execute(),
    ).toEqual([
      {
        user_id: item.sender,
        telegram_charge_id: item.charge,
        stars_amount: '2',
        reason_code: 'target_unavailable',
      },
    ]);
    expect(
      await database
        .selectFrom('nakh.nakhes')
        .select('id')
        .where('sender_user_id', '=', item.sender)
        .execute(),
    ).toEqual([]);
    await reconcile();
    expect(
      (await new PostgresNakhOperationalMetricsStore(database).measure())
        .fundingInvariantMismatchCount,
    ).toBe(0);
  });
  it.each(['closed_by_system', 'cancel_like', 'cancel_not_interested', 'expired'] as const)(
    'preserves receiver-owned terminal %s and its already captured refund across archival',
    async (status) => {
      const item = await terminalScene(status, 'receiver');
      expect(await item.submit()).toMatchObject({ outcome: 'receipt_recorded' });
      const before = await facts(item.lease);
      delete before.pending;
      expect(
        await new PostgresAccountDeletionTerminalPendingStore(database).purgeNext(item.lease),
      ).toEqual({ purgedRows: 1, hasMore: false });
      const after = await facts(item.lease);
      delete after.pending;
      expect(after).toEqual(before);
      for (const result of await Promise.all(Array.from({ length: 20 }, () => item.submit())))
        expect(result).toMatchObject({ outcome: 'replayed' });
      const replayed = await facts(item.lease);
      delete replayed.pending;
      expect(replayed).toEqual(before);
      const receipt = (
        await sql<{
          metadata: unknown;
        }>`SELECT audit.metadata FROM identity.account_deletion_terminal_pending_receipts receipt
        JOIN platform.audit_logs audit ON audit.id=receipt.audit_id WHERE receipt.pending_nakh_id=${item.pendingId}::uuid`.execute(
          database,
        )
      ).rows;
      expect(receipt).toHaveLength(1);
      expect(receipt[0]!.metadata).toMatchObject({
        kind: 'terminal_pending_source',
        rows: 1,
        receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
      });
      expect(JSON.stringify(receipt)).not.toContain('Private unpaid terminal body');
      await sql`DELETE FROM platform.outbox_events WHERE aggregate_id=${item.lease.deletionRecordId}::uuid
        AND event_type='account.deletion-terminal-pending-batch.v1'`.execute(database);
      await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL
        WHERE deletion_record_id=${item.lease.deletionRecordId}::uuid`.execute(database);
      expect(
        (
          await sql<{
            valid: boolean;
          }>`SELECT nakh.original_pending_reference_valid(${item.pendingId}::uuid) AS valid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ valid: true }]);
      await database.connection().execute(async (connection) => {
        await sql`SET TIME ZONE 'Asia/Tehran'`.execute(connection);
        try {
          expect(
            (
              await sql`SELECT nakh.original_pending_reference_valid(id) AS valid,
            nakh.terminal_pending_closure_valid(pending) AS closed FROM nakh.pending_nakh_lifecycle_facts pending
            WHERE id=${item.pendingId}::uuid`.execute(connection)
            ).rows,
          ).toEqual([{ valid: true, closed: true }]);
        } finally {
          await sql`SET TIME ZONE 'UTC'`.execute(connection);
        }
      });
      await expect(
        new PostgresAccountDeletionTerminalPendingStore(database).purgeNext(item.lease),
      ).rejects.toMatchObject({ code: 'conflict' });
    },
  );
  it.each([
    ['identity.account_deletion_terminal_pending_receipts', 'INSERT'],
    ['platform.audit_logs', 'INSERT'],
    ['platform.outbox_events', 'INSERT'],
    ['nakh.pending_nakhes', 'DELETE'],
  ] as const)('rolls back terminal archival when %s %s is suppressed', async (table, operation) => {
    const item = await terminalScene('closed_by_system'),
      original = await facts(item.lease);
    const terminal = new PostgresAccountDeletionTerminalPendingStore(database);
    await sql`CREATE FUNCTION identity.m8_terminal_suppress_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF TG_OP='DELETE' THEN RETURN NULL; END IF;
        IF TG_TABLE_NAME='account_deletion_terminal_pending_receipts' THEN RETURN NULL; END IF;
        IF NEW.event_type='account.deletion-terminal-pending-batch.v1' THEN RETURN NULL; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER m8_terminal_suppress_write BEFORE ${sql.raw(operation)} ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION identity.m8_terminal_suppress_write()`.execute(database);
    try {
      await expect(terminal.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      expect(await facts(item.lease)).toEqual(original);
      expect(
        (
          await sql`SELECT id FROM identity.account_deletion_terminal_pending_receipts
        WHERE pending_nakh_id=${item.pendingId}::uuid`.execute(database)
        ).rows,
      ).toEqual([]);
    } finally {
      await sql`DROP TRIGGER m8_terminal_suppress_write ON ${sql.table(table)}`.execute(database);
      await sql`DROP FUNCTION identity.m8_terminal_suppress_write()`.execute(database);
    }
    expect(await terminal.purgeNext(item.lease)).toEqual({ purgedRows: 1, hasMore: false });
  });
  it.each(['event', 'lease'] as const)(
    'rolls back terminal %s loss at actual deferred commit',
    async (fault) => {
      const item = await terminalScene(
          'closed_by_system',
          'sender',
          fault === 'lease' ? 2000 : 120000,
        ),
        original = await facts(item.lease);
      await expect(
        database.transaction().execute(async (tx) => {
          const result = await sql<{
            removed: number;
          }>`SELECT purged_rows AS removed FROM nakh.purge_deletion_terminal_pending_source(
        ${item.lease.deletionRecordId}::uuid,${item.lease.userId}::uuid,${item.lease.leaseOwner}::uuid,${item.lease.leaseGeneration})`.execute(
            tx,
          );
          expect(result.rows).toEqual([{ removed: 1 }]);
          if (fault === 'lease') await sql`SELECT pg_sleep(2.1)`.execute(tx);
          else
            expect(
              await tx
                .deleteFrom('platform.outbox_events')
                .where('aggregate_id', '=', item.lease.deletionRecordId)
                .where('event_type', '=', 'account.deletion-terminal-pending-batch.v1')
                .returning('id')
                .execute(),
            ).toHaveLength(1);
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await facts(item.lease)).toEqual(original);
    },
  );
  it('denies terminal borrowed fences, ordinary deletion, receipt mutation and retired source reuse', async () => {
    const item = await terminalScene('closed_by_system'),
      original = await facts(item.lease),
      terminal = new PostgresAccountDeletionTerminalPendingStore(database);
    const source = await database
      .selectFrom('nakh.pending_nakhes')
      .selectAll()
      .where('id', '=', item.pendingId)
      .executeTakeFirstOrThrow();
    for (const changed of [
      { deletionRecordId: randomUUID() },
      { userId: randomUUID() },
      { leaseOwner: randomUUID() },
      { leaseGeneration: item.lease.leaseGeneration + 1 },
      { checkpointVersion: 2 },
      { phase: 'evidence_capture' },
    ] as const) {
      await expect(terminal.purgeNext({ ...item.lease, ...changed })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(await facts(item.lease)).toEqual(original);
    }
    await expect(
      sql`DELETE FROM nakh.pending_nakhes WHERE id=${item.pendingId}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    await terminal.purgeNext(item.lease);
    for (const query of [
      sql`UPDATE identity.account_deletion_terminal_pending_receipts SET source_version=2 WHERE pending_nakh_id=${item.pendingId}::uuid`,
      sql`DELETE FROM identity.account_deletion_terminal_pending_receipts WHERE pending_nakh_id=${item.pendingId}::uuid`,
    ])
      await expect(query.execute(database)).rejects.toMatchObject({ code: '55000' });
    await expect(
      database.insertInto('nakh.pending_nakhes').values(source).execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it.each([
    'audit',
    'receipt-version',
    'missing-receipt',
    'refund-owner',
    'refund-amount',
  ] as const)(
    'keeps archived terminal %s corruption visible to full scans and shared financial blockers',
    async (fault) => {
      const item = await terminalScene('closed_by_system');
      await item.submit();
      await new PostgresAccountDeletionTerminalPendingStore(database).purgeNext(item.lease);
      const original = await facts(item.lease);
      const receipt = (
        await sql<{
          saved: Record<string, unknown>;
          auditId: string;
        }>`SELECT to_jsonb(receipt) AS saved,audit_id AS "auditId"
        FROM identity.account_deletion_terminal_pending_receipts receipt WHERE pending_nakh_id=${item.pendingId}::uuid`.execute(
          database,
        )
      ).rows[0]!;
      const audit = await database
        .selectFrom('platform.audit_logs')
        .select('metadata')
        .where('id', '=', receipt.auditId)
        .executeTakeFirstOrThrow();
      const refund = await database
        .selectFrom('billing.refund_records')
        .selectAll()
        .where('payment_record_id', '=', item.paymentId)
        .executeTakeFirstOrThrow();
      const mutate = async (restore: boolean): Promise<void> =>
        database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            if (restore) {
              await sql`DELETE FROM identity.account_deletion_terminal_pending_receipts WHERE pending_nakh_id=${item.pendingId}::uuid`.execute(
                connection,
              );
              await sql`INSERT INTO identity.account_deletion_terminal_pending_receipts SELECT restored.*
              FROM jsonb_populate_record(NULL::identity.account_deletion_terminal_pending_receipts,${JSON.stringify(receipt.saved)}::jsonb) restored`.execute(
                connection,
              );
              await connection
                .updateTable('platform.audit_logs')
                .set({ metadata: audit.metadata })
                .where('id', '=', receipt.auditId)
                .execute();
              await connection
                .updateTable('billing.refund_records')
                .set({ user_id: refund.user_id, stars_amount: refund.stars_amount })
                .where('id', '=', refund.id)
                .execute();
            } else if (fault === 'audit') {
              await connection
                .updateTable('platform.audit_logs')
                .set({
                  metadata: {
                    kind: 'terminal_pending_source',
                    rows: 1,
                    receiptDigest: '0'.repeat(64),
                  },
                })
                .where('id', '=', receipt.auditId)
                .execute();
            } else if (fault === 'receipt-version') {
              await sql`UPDATE identity.account_deletion_terminal_pending_receipts SET source_version=source_version+1
              WHERE pending_nakh_id=${item.pendingId}::uuid`.execute(connection);
            } else if (fault === 'missing-receipt') {
              await sql`DELETE FROM identity.account_deletion_terminal_pending_receipts WHERE pending_nakh_id=${item.pendingId}::uuid`.execute(
                connection,
              );
            } else if (fault === 'refund-owner') {
              await connection
                .updateTable('billing.refund_records')
                .set({ user_id: randomUUID() })
                .where('id', '=', refund.id)
                .execute();
            } else {
              await connection
                .updateTable('billing.refund_records')
                .set({ stars_amount: '3' })
                .where('id', '=', refund.id)
                .execute();
            }
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      try {
        await mutate(false);
        expect(
          (
            await sql`SELECT id FROM nakh.pending_nakh_lifecycle_facts WHERE id=${item.pendingId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toHaveLength(1);
        for (let pass = 0; pass < 2; pass++) {
          await reconcile();
          expect(
            (await new PostgresNakhOperationalMetricsStore(database).measure())
              .fundingInvariantMismatchCount,
          ).toBe(1);
        }
        expect(
          (
            await sql<{
              blocked: boolean;
            }>`SELECT identity.deletion_has_unresolved_shared_payments(${item.lease.userId}::uuid) AS blocked`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ blocked: true }]);
        await expect(
          new PostgresAccountDeletionTerminalPendingStore(database).purgeNext(item.lease),
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(
          await database
            .selectFrom('nakh.pending_nakhes')
            .select('id')
            .where('id', '=', item.pendingId)
            .execute(),
        ).toEqual([]);
        expect(
          await database
            .selectFrom('nakh.nakhes')
            .select('id')
            .where('sender_user_id', '=', item.sender)
            .execute(),
        ).toEqual([]);
      } finally {
        await mutate(true);
      }
      expect(await facts(item.lease)).toEqual(original);
      await reconcile();
      expect(
        (await new PostgresNakhOperationalMetricsStore(database).measure())
          .fundingInvariantMismatchCount,
      ).toBe(0);
      expect(await item.submit()).toMatchObject({ outcome: 'replayed' });
    },
  );
  it('serializes both terminal participant roots into one audited removal without changing either original life', async () => {
    const item = await terminalScene('closed_by_system');
    const other = (
      await database
        .selectFrom('nakh.nakh_flows')
        .select('receiver_user_id')
        .where('sender_user_id', '=', item.sender)
        .executeTakeFirstOrThrow()
    ).receiver_user_id;
    const key = randomBytes(32),
      deletion = new PostgresAccountDeletionStore(database, {
        activeKeyId: 'm8-terminal-pair',
        keys: new Map([['m8-terminal-pair', key]]),
      });
    try {
      const account = await database
        .selectFrom('identity.accounts')
        .select('version')
        .where('user_id', '=', other)
        .executeTakeFirstOrThrow();
      const proof = await deletion.prepare({
        actor: { kind: 'user', userId: other },
        requestId: randomUUID(),
        expectedAccountVersion: account.version,
      });
      const commandId = randomUUID();
      await deletion.request({
        commandId,
        commandType: 'account.delete',
        schemaVersion: 1,
        actor: { kind: 'user', userId: other },
        requestId: randomUUID(),
        idempotencyKey: `m8-terminal-pair:${commandId}`,
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
    const shared = await claim(),
      closure = new PostgresAccountDeletionSharedStore(database);
    while ((await closure.closeNext(shared)).hasMore) {
      /* bounded second participant closure */
    }
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(shared);
    const evidence = await claim();
    await new PostgresAccountDeletionProfileStore(database).archive(evidence);
    expect(await checkpoints.finishEvidence(evidence)).toMatchObject({ phase: 'product_data' });
    const counterpart = await claim();
    expect(counterpart.userId).toBe(other);
    const before = await facts(item.lease),
      otherBefore = await facts(counterpart);
    delete before.pending;
    delete otherBefore.pending;
    const terminal = new PostgresAccountDeletionTerminalPendingStore(database);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        terminal.purgeNext(index % 2 === 0 ? item.lease : counterpart),
      ),
    );
    expect(results.reduce((sum, row) => sum + row.purgedRows, 0)).toBe(1);
    expect(results.every((row) => !row.hasMore)).toBe(true);
    const after = await facts(item.lease),
      otherAfter = await facts(counterpart);
    delete after.pending;
    delete otherAfter.pending;
    expect(after).toEqual(before);
    expect(otherAfter).toEqual(otherBefore);
    expect(
      (
        await sql`SELECT id FROM identity.account_deletion_terminal_pending_receipts WHERE pending_nakh_id=${item.pendingId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toHaveLength(1);
  });
  it.each(['pending_credits', 'telegram_stars'] as const)(
    'archives paid %s bodies with original proof and twenty genuine late capture retries',
    async (funding) => {
      const item = await scene(0, funding, false, 120000, true, 4),
        paid = new PostgresAccountDeletionPaidPendingStore(database),
        pendingId = item.pendingNakhId!,
        late = item.lateCapture!;
      const source = await database
        .selectFrom('nakh.pending_nakhes')
        .selectAll()
        .where('id', '=', pendingId)
        .executeTakeFirstOrThrow();
      expect(source.version).toBe(6);
      expect(source.status).toBe('paid_and_sent');
      const beforeFinal = await facts(item.lease);
      await expect(paid.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      expect(await facts(item.lease)).toEqual(beforeFinal);
      while ((await store.purgeNext(item.lease)).hasMore) {
        /* bounded delivered archival */
      }
      const original = { ...(await facts(item.lease)) };
      delete original.pending;
      expect((original.preview as { preview_count: number }).preview_count).toBeGreaterThan(0);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => paid.purgeNext(item.lease)),
      );
      expect(results.map((row) => row.purgedRows).reduce((sum, count) => sum + count, 0)).toBe(1);
      expect(results.every((row) => !row.hasMore)).toBe(true);
      expect(
        await database
          .selectFrom('nakh.pending_nakhes')
          .select('id')
          .where('id', '=', pendingId)
          .execute(),
      ).toEqual([]);
      const preserved = { ...(await facts(item.lease)) };
      delete preserved.pending;
      expect(preserved).toEqual(original);
      const proof = (
        await sql<{
          valid: boolean;
          funded: boolean;
          version: number;
          proof: boolean;
          receipts: number;
        }>`
        SELECT nakh.original_pending_reference_valid(${pendingId}::uuid) AS valid,
          nakh.original_funded_scope_valid(delivered.id,delivered.nakh_flow_id,delivered.sender_user_id,
            delivered.receiver_user_id,delivered.funding_type,delivered.credit_transaction_id,delivered.payment_record_id) AS funded,
          pending.version, pending.shape_valid AS proof,
          (SELECT count(*)::integer FROM identity.account_deletion_paid_pending_receipts WHERE pending_nakh_id=pending.id) AS receipts
        FROM nakh.pending_nakh_lifecycle_facts pending JOIN nakh.nakh_lifecycle_facts delivered
          ON delivered.nakh_flow_id=pending.nakh_flow_id
        WHERE pending.id=${pendingId}::uuid`.execute(database)
      ).rows[0]!;
      expect(proof).toEqual({ valid: true, funded: true, version: 6, proof: true, receipts: 1 });
      const audits = (
        await sql<{ metadata: unknown }>`SELECT audit.metadata FROM platform.audit_logs audit
        JOIN identity.account_deletion_paid_pending_receipts receipt ON receipt.audit_id=audit.id
        WHERE receipt.pending_nakh_id=${pendingId}::uuid`.execute(database)
      ).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({
        kind: 'paid_pending_source',
        rows: 1,
        receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
      });
      expect(JSON.stringify(audits)).not.toContain(source.text);
      expect(JSON.stringify(audits)).not.toContain(source.request_hash);
      const statusEvents = async (): Promise<number> =>
        Number(
          (
            await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM platform.outbox_events WHERE aggregate_id=${pendingId}::uuid`.execute(
              database,
            )
          ).rows[0]!.count,
        );
      const priorStatusEvents = await statusEvents();
      if (item.replayFunding)
        for (const replay of await Promise.all(
          Array.from({ length: 20 }, () => item.replayFunding!()),
        ))
          expect(replay).toMatchObject({
            replayed: true,
            nakhId: item.nakhId,
            outcome: 'fulfilled',
          });
      expect(
        await database
          .selectFrom('profile.profiles')
          .select('id')
          .where('user_id', '=', item.lease.userId)
          .execute(),
      ).toEqual([]);
      const captures = await Promise.all(Array.from({ length: 20 }, () => late.submit()));
      expect(captures.filter((row) => row.outcome === 'receipt_recorded')).toHaveLength(1);
      expect(captures.filter((row) => row.outcome === 'replayed')).toHaveLength(19);
      const refunds = await database
        .selectFrom('billing.refund_records')
        .selectAll()
        .where('payment_record_id', '=', late.paymentRecordId)
        .execute();
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        user_id: item.lease.userId,
        funding_type: 'telegram_stars',
        payment_record_id: late.paymentRecordId,
        telegram_charge_id: late.telegramChargeId,
        stars_amount: late.starsAmount.toString(),
        status: 'pending',
        reason_code: 'target_unavailable',
      });
      expect(
        await database
          .selectFrom('billing.payment_fulfillments')
          .select(['state', 'last_error_code'])
          .where('payment_record_id', '=', late.paymentRecordId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'correction_required', last_error_code: 'payment_state_conflict' });
      expect(
        await database
          .selectFrom('platform.outbox_events')
          .select('id')
          .where('aggregate_id', '=', late.paymentRecordId)
          .where('event_type', '=', 'billing.payment-correction-required.v1')
          .execute(),
      ).toHaveLength(1);
      expect(await statusEvents()).toBe(priorStatusEvents);
      expect(
        await database
          .selectFrom('nakh.nakhes')
          .select('id')
          .where('id', '=', item.nakhId)
          .execute(),
      ).toEqual([]);
      expect(
        await database
          .selectFrom('nakh.pending_nakhes')
          .select('id')
          .where('id', '=', pendingId)
          .execute(),
      ).toEqual([]);
      const afterCorrection = await facts(item.lease);
      for (const key of ['credits', 'anchors', 'flows', 'account', 'root', 'preview'])
        expect(afterCorrection[key]).toEqual(original[key]);
      await reconcile();
      expect(
        (await new PostgresNakhOperationalMetricsStore(database).measure())
          .fundingInvariantMismatchCount,
      ).toBe(0);
      await database.transaction().execute(async (tx) => {
        await sql`SET LOCAL TimeZone='Asia/Tehran'`.execute(tx);
        expect(
          (
            await sql<{
              valid: boolean;
            }>`SELECT nakh.original_pending_reference_valid(${pendingId}::uuid) AS valid`.execute(
              tx,
            )
          ).rows[0]!.valid,
        ).toBe(true);
      });
      // Transport expiry and worker expiry cannot revoke old proof or mint a new removal.
      await sql`DELETE FROM platform.outbox_events WHERE event_type='account.deletion-paid-pending-batch.v1'
        AND aggregate_id=${item.lease.deletionRecordId}::uuid`.execute(database);
      await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL
        WHERE deletion_record_id=${item.lease.deletionRecordId}::uuid`.execute(database);
      expect(
        (
          await sql<{
            valid: boolean;
          }>`SELECT nakh.original_pending_reference_valid(${pendingId}::uuid) AS valid`.execute(
            database,
          )
        ).rows[0]!.valid,
      ).toBe(true);
      await expect(paid.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      if (item.replayFunding)
        expect(await item.replayFunding()).toMatchObject({ replayed: true, nakhId: item.nakhId });
    },
  );
  it.each([
    ['identity.account_deletion_paid_pending_receipts', 'INSERT'],
    ['platform.audit_logs', 'INSERT'],
    ['platform.outbox_events', 'INSERT'],
    ['nakh.pending_nakhes', 'DELETE'],
  ] as const)(
    'rolls back paid pending archival when %s %s is suppressed',
    async (table, operation) => {
      const item = await scene(0, 'pending_credits');
      await store.purgeNext(item.lease);
      const original = await facts(item.lease),
        paid = new PostgresAccountDeletionPaidPendingStore(database);
      await sql`CREATE FUNCTION identity.m8_paid_suppress_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RETURN NULL; END IF;
        IF TG_TABLE_NAME='account_deletion_paid_pending_receipts' THEN RETURN NULL; END IF;
        IF NEW.event_type='account.deletion-paid-pending-batch.v1' THEN RETURN NULL; END IF;
        RETURN NEW;
      END $$`.execute(database);
      await sql`CREATE TRIGGER m8_paid_suppress_write BEFORE ${sql.raw(operation)} ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION identity.m8_paid_suppress_write()`.execute(database);
      try {
        await expect(paid.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await facts(item.lease)).toEqual(original);
        expect(
          (
            await sql`SELECT id FROM identity.account_deletion_paid_pending_receipts
        WHERE pending_nakh_id=${item.pendingNakhId}::uuid`.execute(database)
          ).rows,
        ).toEqual([]);
      } finally {
        await sql`DROP TRIGGER m8_paid_suppress_write ON ${sql.table(table)}`.execute(database);
        await sql`DROP FUNCTION identity.m8_paid_suppress_write()`.execute(database);
      }
      expect(await paid.purgeNext(item.lease)).toEqual({ purgedRows: 1, hasMore: false });
    },
  );
  it.each(['event', 'lease'] as const)(
    'rejects paid pending %s loss at actual deferred commit',
    async (fault) => {
      const item = await scene(0, 'pending_credits', false, fault === 'lease' ? 2000 : 120000);
      await store.purgeNext(item.lease);
      const original = await facts(item.lease);
      await expect(
        database.transaction().execute(async (tx) => {
          const result = await sql<{
            removed: number;
          }>`SELECT purged_rows AS removed FROM nakh.purge_deletion_paid_pending_source(
        ${item.lease.deletionRecordId}::uuid,${item.lease.userId}::uuid,${item.lease.leaseOwner}::uuid,
        ${item.lease.leaseGeneration})`.execute(tx);
          expect(result.rows).toEqual([{ removed: 1 }]);
          if (fault === 'event') {
            const erased = await tx
              .deleteFrom('platform.outbox_events')
              .where('aggregate_id', '=', item.lease.deletionRecordId)
              .where('event_type', '=', 'account.deletion-paid-pending-batch.v1')
              .returning('id')
              .execute();
            expect(erased).toHaveLength(1);
          } else {
            await sql`SELECT pg_sleep(2.1)`.execute(tx);
          }
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await facts(item.lease)).toEqual(original);
    },
  );
  it('rejects paid pending forged fences and ordinary source or proof deletion', async () => {
    const item = await scene(0, 'pending_credits');
    await store.purgeNext(item.lease);
    const original = await facts(item.lease),
      paid = new PostgresAccountDeletionPaidPendingStore(database);
    for (const changed of [
      { deletionRecordId: randomUUID() },
      { userId: randomUUID() },
      { leaseOwner: randomUUID() },
      { leaseGeneration: item.lease.leaseGeneration + 1 },
      { checkpointVersion: 2 },
      { phase: 'evidence_capture' },
    ] as const) {
      await expect(paid.purgeNext({ ...item.lease, ...changed })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(await facts(item.lease)).toEqual(original);
    }
    await expect(
      sql`DELETE FROM nakh.pending_nakhes WHERE id=${item.pendingNakhId}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    expect(await facts(item.lease)).toEqual(original);
    await paid.purgeNext(item.lease);
    for (const query of [
      sql`UPDATE identity.account_deletion_paid_pending_receipts SET source_version=2 WHERE pending_nakh_id=${item.pendingNakhId}::uuid`,
      sql`DELETE FROM identity.account_deletion_paid_pending_receipts WHERE pending_nakh_id=${item.pendingNakhId}::uuid`,
    ])
      await expect(query.execute(database)).rejects.toMatchObject({ code: '55000' });
  });
  it.each([
    'billing.telegram_stars_receipts',
    'billing.payment_provider_events',
    'billing.payment_fulfillments',
    'billing.refund_records',
    'platform.outbox_events',
  ] as const)(
    'rejects genuine archived late capture with suppressed %s and permits exact retry',
    async (table) => {
      const item = await scene(0, 'pending_credits', false, 120000, true),
        late = item.lateCapture!;
      await store.purgeNext(item.lease);
      await new PostgresAccountDeletionPaidPendingStore(database).purgeNext(item.lease);
      const original = await facts(item.lease);
      await sql`CREATE FUNCTION billing.m8_pending_suppress_capture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$`.execute(database);
      await sql`CREATE TRIGGER m8_pending_suppress_capture BEFORE INSERT ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION billing.m8_pending_suppress_capture()`.execute(database);
      try {
        await expect(late.submit()).rejects.toBeDefined();
        expect(await facts(item.lease)).toEqual(original);
        expect(
          await database
            .selectFrom('billing.refund_records')
            .select('id')
            .where('payment_record_id', '=', late.paymentRecordId)
            .execute(),
        ).toEqual([]);
        expect(
          await database
            .selectFrom('platform.outbox_events')
            .select('id')
            .where('aggregate_id', '=', late.paymentRecordId)
            .execute(),
        ).toEqual([]);
      } finally {
        await sql`DROP TRIGGER m8_pending_suppress_capture ON ${sql.table(table)}`.execute(
          database,
        );
        await sql`DROP FUNCTION billing.m8_pending_suppress_capture()`.execute(database);
      }
      expect(await late.submit()).toMatchObject({ outcome: 'receipt_recorded' });
      expect(await late.submit()).toMatchObject({ outcome: 'replayed' });
      expect(
        await database
          .selectFrom('billing.refund_records')
          .select('id')
          .where('payment_record_id', '=', late.paymentRecordId)
          .execute(),
      ).toHaveLength(1);
    },
  );
  it.each(['audit', 'receipt-version', 'missing-receipt'] as const)(
    'keeps archived pending %s corruption visible and rejects funding replay',
    async (fault) => {
      const item = await scene(0, 'telegram_stars');
      await store.purgeNext(item.lease);
      await new PostgresAccountDeletionPaidPendingStore(database).purgeNext(item.lease);
      const original = await facts(item.lease);
      const receipt = (
        await sql<{ saved: Record<string, unknown>; auditId: string }>`
        SELECT to_jsonb(receipt) AS saved,audit_id AS "auditId"
        FROM identity.account_deletion_paid_pending_receipts receipt
        WHERE pending_nakh_id=${item.pendingNakhId}::uuid`.execute(database)
      ).rows[0]!;
      const audit = await database
        .selectFrom('platform.audit_logs')
        .select('metadata')
        .where('id', '=', receipt.auditId)
        .executeTakeFirstOrThrow();
      const mutate = async (restore: boolean): Promise<void> =>
        database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            if (restore) {
              await sql`DELETE FROM identity.account_deletion_paid_pending_receipts
              WHERE pending_nakh_id=${item.pendingNakhId}::uuid`.execute(connection);
              await sql`INSERT INTO identity.account_deletion_paid_pending_receipts
              SELECT restored.* FROM jsonb_populate_record(NULL::identity.account_deletion_paid_pending_receipts,
              ${JSON.stringify(receipt.saved)}::jsonb) restored`.execute(connection);
              await connection
                .updateTable('platform.audit_logs')
                .set({ metadata: audit.metadata })
                .where('id', '=', receipt.auditId)
                .execute();
            } else if (fault === 'audit') {
              await connection
                .updateTable('platform.audit_logs')
                .set({
                  metadata: { kind: 'paid_pending_source', rows: 1, receiptDigest: '0'.repeat(64) },
                })
                .where('id', '=', receipt.auditId)
                .execute();
            } else if (fault === 'receipt-version') {
              await sql`UPDATE identity.account_deletion_paid_pending_receipts SET source_version=source_version+1
              WHERE pending_nakh_id=${item.pendingNakhId}::uuid`.execute(connection);
            } else {
              await sql`DELETE FROM identity.account_deletion_paid_pending_receipts
              WHERE pending_nakh_id=${item.pendingNakhId}::uuid`.execute(connection);
            }
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      try {
        await mutate(false);
        const visible = (
          await sql<{ valid: boolean; shape: boolean }>`SELECT
          nakh.original_pending_reference_valid(id) AS valid,shape_valid AS shape
          FROM nakh.pending_nakh_lifecycle_facts WHERE id=${item.pendingNakhId}::uuid`.execute(
            database,
          )
        ).rows;
        expect(visible).toEqual([{ valid: false, shape: false }]);
        for (let attempt = 0; attempt < 2; attempt++) {
          await reconcile();
          expect(
            (await new PostgresNakhOperationalMetricsStore(database).measure())
              .fundingInvariantMismatchCount,
          ).toBeGreaterThan(0);
        }
        await expect(item.replayFunding!()).rejects.toBeDefined();
        expect(await facts(item.lease)).toEqual(original);
      } finally {
        await mutate(true);
      }
      await reconcile();
      expect(
        (await new PostgresNakhOperationalMetricsStore(database).measure())
          .fundingInvariantMismatchCount,
      ).toBe(0);
      expect(await item.replayFunding!()).toMatchObject({ replayed: true, nakhId: item.nakhId });
    },
  );
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
  it.each(['credits', 'pending_credits'] as const)(
    'serializes competing participant deletion roots with %s funding without duplicate archival or financial changes',
    async (funding) => {
      const item = await scene(0, funding);
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
      expect(
        await new PostgresAccountDeletionProfileStore(database).archive(evidence),
      ).toMatchObject({ archived: true });
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
      if (item.pendingNakhId) {
        const paid = new PostgresAccountDeletionPaidPendingStore(database);
        const pendingResults = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            paid.purgeNext(index % 2 === 0 ? item.lease : counterpart),
          ),
        );
        expect(pendingResults.reduce((total, result) => total + result.purgedRows, 0)).toBe(1);
        expect(pendingResults.every((result) => !result.hasMore)).toBe(true);
        delete senderFacts.pending;
        delete receiverFacts.pending;
        const senderAfter = await facts(item.lease),
          receiverAfter = await facts(counterpart);
        delete senderAfter.pending;
        delete receiverAfter.pending;
        expect(senderAfter).toEqual(senderFacts);
        expect(receiverAfter).toEqual(receiverFacts);
        expect(
          (
            await sql`SELECT id FROM identity.account_deletion_paid_pending_receipts
        WHERE pending_nakh_id=${item.pendingNakhId}::uuid`.execute(database)
          ).rows,
        ).toHaveLength(1);
      }
    },
  );
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
  it.each([
    { funding: 'pending_credits', archived: false },
    { funding: 'pending_credits', archived: true },
    { funding: 'telegram_stars', archived: false },
    { funding: 'telegram_stars', archived: true },
  ] as const)(
    'requires exact original $funding funding with archived=$archived for archival, reconciliation and replay',
    async ({ funding, archived }) => {
      const item = await scene(0, funding),
        source = await database
          .selectFrom('nakh.nakhes')
          .selectAll()
          .where('id', '=', item.nakhId)
          .executeTakeFirstOrThrow(),
        pending = await database
          .selectFrom('nakh.pending_nakhes')
          .selectAll()
          .where('nakh_flow_id', '=', source.nakh_flow_id)
          .executeTakeFirstOrThrow(),
        anchor = await database
          .selectFrom('nakh.pending_nakh_reference_anchors')
          .selectAll()
          .where('id', '=', pending.id)
          .executeTakeFirstOrThrow(),
        intent = await database
          .selectFrom('billing.pending_payments')
          .selectAll()
          .where('id', '=', pending.pending_payment_id)
          .executeTakeFirstOrThrow(),
        credit =
          source.credit_transaction_id === null
            ? undefined
            : await database
                .selectFrom('billing.credit_transactions')
                .selectAll()
                .where('id', '=', source.credit_transaction_id)
                .executeTakeFirstOrThrow(),
        original = await facts(item.lease);
      const valid = async (): Promise<boolean> =>
        (
          await sql<{ valid: boolean }>`SELECT
        nakh.original_funded_scope_valid(${source.id}::uuid,${source.nakh_flow_id}::uuid,
          ${source.sender_user_id}::uuid,${source.receiver_user_id}::uuid,${source.funding_type},
          ${source.credit_transaction_id}::uuid,${source.payment_record_id}::uuid) AS valid`.execute(
            database,
          )
        ).rows[0]!.valid;
      const originalIntent = (
        await sql<{ saved: Record<string, unknown> }>`SELECT to_jsonb(intent) AS saved
          FROM billing.pending_payments intent WHERE id=${intent.id}::uuid`.execute(database)
      ).rows[0]!.saved;
      if (archived)
        expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 3, hasMore: false });
      for (const fault of [
        'sender-life',
        'receiver-life',
        'intent',
        'missing-anchor',
        'missing-intent',
        'intent-status',
        'intent-expiry',
        ...(funding === 'pending_credits' ? (['missing-credit-link'] as const) : []),
      ] as const) {
        const before = await ordinary(item.nakhId);
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            if (fault === 'missing-credit-link')
              await connection
                .updateTable('billing.credit_transactions')
                .set({ pending_payment_id: null })
                .where('id', '=', credit!.id)
                .execute();
            else if (fault === 'intent-status')
              await connection
                .updateTable('billing.pending_payments')
                .set({ status: 'expired' })
                .where('id', '=', intent.id)
                .execute();
            else if (fault === 'intent-expiry')
              await connection
                .updateTable('billing.pending_payments')
                .set({ expires_at: new Date(intent.expires_at.getTime() + 1000) })
                .where('id', '=', intent.id)
                .execute();
            else if (fault === 'missing-intent')
              await connection
                .deleteFrom('billing.pending_payments')
                .where('id', '=', intent.id)
                .execute();
            else if (fault === 'missing-anchor')
              await connection
                .deleteFrom('nakh.pending_nakh_reference_anchors')
                .where('id', '=', anchor.id)
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
                .where('id', '=', anchor.id)
                .execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
        try {
          expect(await valid()).toBe(false);
          const corrupted = await facts(item.lease);
          if (!archived) {
            for (const outcome of await Promise.allSettled(
              Array.from({ length: 20 }, () => store.purgeNext(item.lease)),
            )) {
              expect(outcome.status).toBe('rejected');
              if (outcome.status === 'rejected')
                expect(outcome.reason as unknown).toMatchObject({ code: 'conflict' });
            }
          }
          if (item.replayFunding) {
            for (const outcome of await Promise.allSettled(
              Array.from({ length: 20 }, item.replayFunding),
            )) {
              expect(outcome.status).toBe('rejected');
              if (outcome.status === 'rejected')
                expect(outcome.reason as unknown).toMatchObject({ code: 'conflict' });
            }
          }
          for (let scan = 0; scan < 2; scan++) await reconcile();
          expect(
            await database
              .selectFrom('billing.reconciliation_anomalies')
              .select(['disposition', 'safe_detail'])
              .where('entity_id', '=', item.nakhId)
              .where('anomaly_type', '=', 'delivered_nakh_funding_proof_invalid')
              .execute(),
          ).toEqual([
            {
              disposition: 'quarantined',
              safe_detail: {
                fundingType: source.funding_type,
                creditProofCount: funding === 'pending_credits' ? '1' : '0',
                paymentProofCount: funding === 'telegram_stars' ? '1' : '0',
                // Canonical findings retain the first sender-life observation.
                originalFundingLifeValid: 'true',
                originalReferenceValid: 'true',
                originalFundingBindingValid: 'false',
              },
            },
          ]);
          expect(
            (await new PostgresNakhOperationalMetricsStore(database).measure())
              .fundingInvariantMismatchCount,
            // Both source entities are unhealthy; removing only a credit-to-intent
            // link damages the delivered funding proof without damaging pending.
          ).toBe(fault === 'missing-credit-link' ? 1 : 2);
          expect(await ordinary(item.nakhId)).toEqual(before);
          expect(await facts(item.lease)).toEqual(corrupted);
        } finally {
          await database.connection().execute(async (connection) => {
            await sql`SET session_replication_role=replica`.execute(connection);
            try {
              if (credit !== undefined)
                await connection
                  .updateTable('billing.credit_transactions')
                  .set({ pending_payment_id: credit.pending_payment_id })
                  .where('id', '=', credit.id)
                  .execute();
              await connection
                .insertInto('billing.pending_payments')
                .values(intent)
                .onConflict((conflict) => conflict.column('id').doUpdateSet(intent))
                .execute();
              // JS Date drops native microseconds. Preserve the exact original
              // financial timestamps even when a physically missing row is restored.
              await sql`UPDATE billing.pending_payments intent
                  SET created_at=restored.created_at,expires_at=restored.expires_at,resolved_at=restored.resolved_at
                  FROM jsonb_populate_record(NULL::billing.pending_payments,${JSON.stringify(originalIntent)}::jsonb) restored
                  WHERE intent.id=restored.id`.execute(connection);
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
        expect(await valid()).toBe(true);
        await reconcile();
        expect(
          (await new PostgresNakhOperationalMetricsStore(database).measure())
            .fundingInvariantMismatchCount,
        ).toBe(0);
        expect(await facts(item.lease)).toEqual(original);
      }
      if (item.replayFunding)
        for (const result of await Promise.all(Array.from({ length: 20 }, item.replayFunding)))
          expect(result).toMatchObject({
            outcome: 'fulfilled',
            nakhId: item.nakhId,
            replayed: true,
          });
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
