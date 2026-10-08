import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AesGcmChatReportSnapshotProtector,
  ReportTokens,
  RunNakhReconciliationBatchHandler,
} from '@nakh/application';
import type {
  AccountDeletionLease,
  MarkChatReadWrite,
  ChangeChatMuteWrite,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import {
  createReportChat,
  createReportMessage,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresChatStateStore } from './chat-state-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresPaidActionStore } from './paid-action-store.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';
import { PostgresDirectNakhStore } from './direct-nakh-store.js';
import { PostgresNakhReconciliationStore } from './nakh-reconciliation-store.js';
import { PostgresPrepareChatReportEvidenceHandler } from './chat-report-source-store.js';
import { PostgresSubmitChatReportHandler } from './chat-report-submission-store.js';
import { PostgresUnmatchStore } from './unmatch-store.js';
import { lockUserPair } from './pair-lock.js';
import { PostgresFundingStore } from './funding-store.js';
import { PostgresTelegramStarsReceiptStore } from './payment-receipt-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 bounded shared closure', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let store: PostgresAccountDeletionSharedStore, work: PostgresAccountDeletionWorkStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_m8_shared');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
    store = new PostgresAccountDeletionSharedStore(database);
    work = new PostgresAccountDeletionWorkStore(database);
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
    const leases = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(leases).toHaveLength(1);
    return leases[0]!;
  }
  async function counterpart(): Promise<string> {
    const id = await createReportUser(database, true);
    const at = new Date();
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: id, created_at: at, updated_at: at })
      .execute();
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: id, created_at: at, updated_at: at })
      .execute();
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: id, created_at: at, updated_at: at })
      .execute();
    return id;
  }
  async function activeOwner(id: string, template: string): Promise<void> {
    const profile = await database
      .selectFrom('profile.profiles')
      .selectAll()
      .where('user_id', '=', template)
      .executeTakeFirstOrThrow();
    await database
      .insertInto('profile.profiles')
      .values({ ...profile, id: randomUUID(), user_id: id })
      .execute();
    await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${id}::uuid`.execute(
      database,
    );
  }
  async function credit(id: string): Promise<void> {
    await new PostgresCreditLedgerStore(database).append({
      transactionId: randomUUID(),
      userId: id,
      transactionType: 'admin_adjustment',
      amount: 10n,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
  }
  async function chat(
    owner: string,
    other: string,
  ): Promise<{ matchId: string; chatSessionId: string }> {
    const scope = await createReportChat(database, owner, other);
    const [low, high] = [owner, other].sort() as [string, string];
    await database
      .insertInto('interaction.user_pair_states')
      .values({
        user_low_id: low,
        user_high_id: high,
        state: 'matched',
        reason_code: 'mutual_like',
        changed_at: new Date(),
      })
      .execute();
    await createReportMessage(database, scope.chatSessionId, owner);
    return scope;
  }
  async function counts(
    recordId: string,
  ): Promise<{ audits: number; events: number; notices: number }> {
    const result = await sql<{ audits: string; events: string; notices: string }>`SELECT
      (SELECT count(*) FROM platform.audit_logs WHERE subject_id=${recordId}::uuid AND event_type='account.shared-scope-closed.v1') AS audits,
      (SELECT count(*) FROM platform.outbox_events WHERE aggregate_id=${recordId}::uuid AND event_type='account.shared-scope-closed.v1') AS events,
      (SELECT count(*) FROM notification.notifications WHERE deduplication_key LIKE ${`account-deleted:${recordId}:%`}) AS notices`.execute(
      database,
    );
    const row = result.rows[0]!;
    return { audits: Number(row.audits), events: Number(row.events), notices: Number(row.notices) };
  }
  async function capturedPayment(role: 'sender' | 'receiver'): Promise<{
    userId: string;
    recordId: string;
    paymentId: string;
    pendingId: string;
    sender: string;
    receipts: PostgresTelegramStarsReceiptStore;
    write: Parameters<PostgresTelegramStarsReceiptStore['fulfillPendingNakh']>[0];
  }> {
    const other = await counterpart();
    const telegramId = String(9_000_000_000_000 + Math.floor(Math.random() * 100_000_000));
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: other,
        telegram_user_id: telegramId,
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
    const receipts = new PostgresTelegramStarsReceiptStore(
      database,
      { uuid: randomUUID },
      { digest },
    );
    let paymentId!: string, pendingId!: string, sender!: string;
    const fixture = await createDeletionFixture(database, async (owner) => {
      await activeOwner(owner, other);
      sender = role === 'sender' ? owner : other;
      const receiver = role === 'receiver' ? owner : other;
      const created = await new PostgresPendingNakhStore(database).createPending({
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
            text: 'Synthetic financial closure',
            autoSettleAuthorized: true,
          },
        },
        flowId: randomUUID(),
        pendingNakhId: randomUUID(),
        pendingPaymentId: randomUUID(),
        flowEventId: randomUUID(),
        pendingEventId: randomUUID(),
      });
      pendingId = created.pendingNakhId;
      const cleartext = randomBytes(24).toString('base64url');
      const attempt = await new PostgresFundingStore(database).prepareStarsAttempt({
        paymentRecordId: randomUUID(),
        fundingIntentId: created.fundingIntentId,
        expectedVersion: 1,
        userId: sender,
        idempotencyKey: randomUUID(),
        providerEnvironment: 'test',
        providerBotIdDigest: 'b'.repeat(64),
        payload: {
          cleartext,
          digest: digest(cleartext),
          ciphertext: randomBytes(64),
          keyId: 'm8-test',
        },
      });
      paymentId = attempt.paymentRecordId;
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
            keyId: 'm8-test',
            schemaVersion: 1,
          },
        }),
      ).toMatchObject({ outcome: 'receipt_recorded' });
    });
    const claim = (
      await receipts.claimFulfillments({ owner: 'm8-financial', leaseMs: 120000, limit: 100 })
    ).find((item) => item.paymentRecordId === paymentId)!;
    expect(claim).toBeDefined();
    const write = {
      paymentRecordId: paymentId,
      owner: 'm8-financial',
      fenceToken: claim.fenceToken,
      nakhId: randomUUID(),
      historyId: randomUUID(),
      refundRecordId: randomUUID(),
      deliveredEventId: randomUUID(),
      paymentTerminalEventId: randomUUID(),
    };
    return { ...fixture, paymentId, pendingId, sender, receipts, write };
  }
  it.each(['sender', 'receiver'] as const)(
    'waits for exact refund authority when the %s deletes after capture',
    async (role) => {
      const scene = await capturedPayment(role),
        lease = await claim();
      const payments = await database
        .selectFrom('billing.payment_records')
        .selectAll()
        .where('id', '=', scene.paymentId)
        .execute();
      const provider = await database
        .selectFrom('billing.telegram_stars_receipts')
        .selectAll()
        .where('payment_record_id', '=', scene.paymentId)
        .execute();
      const ledger = await database
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('user_id', '=', scene.sender)
        .execute();
      const waits = await Promise.all(Array.from({ length: 20 }, () => store.closeNext(lease)));
      expect(
        waits.every(
          (result) => result.waitingForFinancialResolution && !result.changed && result.hasMore,
        ),
      ).toBe(true);
      expect(await counts(scene.recordId)).toEqual({ audits: 0, events: 0, notices: 0 });
      const checkpoint = new PostgresAccountDeletionCheckpointStore(database);
      await expect(checkpoint.finishShared(lease)).rejects.toMatchObject({ code: 'conflict' });
      const results = await Promise.all([
        ...Array.from({ length: 20 }, () => scene.receipts.fulfillPendingNakh(scene.write)),
        ...Array.from({ length: 20 }, () => store.closeNext(lease)),
      ]);
      expect(
        results.slice(0, 20).filter((result) => 'replayed' in result && !result.replayed),
      ).toHaveLength(1);
      expect(await store.closeNext(lease)).toEqual({ examined: 0, changed: false, hasMore: false });
      expect(
        await database
          .selectFrom('billing.payment_records')
          .selectAll()
          .where('id', '=', scene.paymentId)
          .execute(),
      ).toEqual(payments);
      expect(
        await database
          .selectFrom('billing.telegram_stars_receipts')
          .selectAll()
          .where('payment_record_id', '=', scene.paymentId)
          .execute(),
      ).toEqual(provider);
      expect(
        await database
          .selectFrom('billing.credit_transactions')
          .selectAll()
          .where('user_id', '=', scene.sender)
          .execute(),
      ).toEqual(ledger);
      expect(
        await database
          .selectFrom('nakh.nakhes')
          .select('id')
          .where('payment_record_id', '=', scene.paymentId)
          .execute(),
      ).toHaveLength(0);
      const refunds = await database
        .selectFrom('billing.refund_records')
        .select(['id', 'status'])
        .where('payment_record_id', '=', scene.paymentId)
        .execute();
      expect(refunds).toEqual([{ id: scene.write.refundRecordId, status: 'pending' }]);
      const finishes = await Promise.all(
        Array.from({ length: 20 }, () => checkpoint.finishShared(lease)),
      );
      expect(finishes.filter((result) => !result.replayed)).toHaveLength(1);
      await sql`DELETE FROM platform.outbox_events WHERE aggregate_id=${scene.recordId}::uuid`.execute(
        database,
      );
      expect(await checkpoint.finishShared(lease)).toMatchObject({ replayed: true });
    },
  );
  it('denies a terminal paid row with missing or altered refund bindings at the database checkpoint', async () => {
    const scene = await capturedPayment('sender'),
      lease = await claim();
    await scene.receipts.fulfillPendingNakh(scene.write);
    const mutations = [
      `DELETE FROM billing.refund_records WHERE id='${scene.write.refundRecordId}'`,
      `UPDATE billing.refund_records SET telegram_charge_id='wrong',version=version+1 WHERE id='${scene.write.refundRecordId}'`,
      `UPDATE billing.refund_records SET stars_amount=stars_amount+1,version=version+1 WHERE id='${scene.write.refundRecordId}'`,
      `UPDATE billing.refund_records SET reason_code='system_failure',version=version+1 WHERE id='${scene.write.refundRecordId}'`,
      `UPDATE billing.refund_records SET idempotency_key='wrong-key',version=version+1 WHERE id='${scene.write.refundRecordId}'`,
      `UPDATE billing.refund_records SET user_id=(SELECT receiver_user_id FROM nakh.nakh_flows WHERE id=(SELECT nakh_flow_id FROM nakh.pending_nakhes WHERE id='${scene.pendingId}')),version=version+1 WHERE id='${scene.write.refundRecordId}'`,
    ];
    for (const mutation of mutations) {
      const rolledBack = new Error('rollback synthetic corruption');
      await expect(
        database.transaction().execute(async (tx) => {
          // Only this isolated synthetic transaction bypasses the immutable UPDATE
          // guard; rollback restores the guard and exact good row before normal tests.
          await sql`ALTER TABLE billing.refund_records DISABLE TRIGGER refund_record_guard`.execute(
            tx,
          );
          await sql.raw(mutation).execute(tx);
          const proof = await sql<{ bound: boolean; open: boolean }>`SELECT
          billing.pending_nakh_has_bound_closure(${scene.pendingId}::uuid) AS bound,
          identity.deletion_has_open_shared_scopes(${scene.userId}::uuid) AS open`.execute(tx);
          expect(proof.rows[0]).toEqual({ bound: false, open: true });
          await sql`SAVEPOINT denied_checkpoint`.execute(tx);
          await expect(
            sql`SELECT * FROM identity.finish_deletion_shared_phase(${scene.recordId}::uuid,
          ${scene.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration},1)`.execute(tx),
          ).rejects.toMatchObject({ code: '40001' });
          await sql`ROLLBACK TO SAVEPOINT denied_checkpoint`.execute(tx);
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);
    }
    expect(await store.closeNext(lease)).toMatchObject({ hasMore: false });
    expect(
      await new PostgresAccountDeletionCheckpointStore(database).finishShared(lease),
    ).toMatchObject({ checkpointVersion: 2 });
  });
  it('twenty retries close one pair, revoke paid access and preserve immutable report evidence and money', async () => {
    const other = await counterpart();
    let scope!: { matchId: string; chatSessionId: string }, reportId!: string;
    const fixture = await createDeletionFixture(database, async (owner) => {
      await activeOwner(owner, other);
      scope = await chat(owner, other);
      await credit(other);
      await new PostgresPaidActionStore(database).spendCredits({
        featureUnlockId: randomUUID(),
        creditTransactionId: randomUUID(),
        outboxEventId: randomUUID(),
        userId: other,
        target: { type: 'match', targetId: scope.matchId },
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      const values = new Map<string, string>(),
        key = Buffer.alloc(32, 73);
      const tokens = new ReportTokens(
        {
          get: (id) => Promise.resolve(values.get(id)),
          putIfAbsent: (id, value) => {
            values.set(id, value);
            return Promise.resolve(true);
          },
        },
        key,
      );
      const actor = { kind: 'user' as const, userId: other };
      const source = await tokens.issueSource(other, { kind: 'match', referenceId: scope.matchId });
      const prepared = await new PostgresPrepareChatReportEvidenceHandler(database, tokens).execute(
        {
          actor,
          requestId: randomUUID(),
          sourceActionToken: source.token,
          requestedEvidenceTypes: ['chat'],
        },
        actor,
      );
      const result = await new PostgresSubmitChatReportHandler(
        database,
        tokens,
        new AesGcmChatReportSnapshotProtector('m8-shared-test', 1, key),
      ).execute(
        {
          commandType: 'moderation.submit-report',
          schemaVersion: 1,
          actor,
          commandId: randomUUID(),
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: {
            evidenceIntentToken: prepared.evidenceIntentToken,
            reasonCode: 'harassment',
            text: 'Synthetic retained explanation',
          },
        },
        actor,
      );
      reportId = result.reportId;
    });
    const ledger = await database
      .selectFrom('billing.credit_transactions')
      .selectAll()
      .where('user_id', '=', other)
      .execute();
    const snapshots = await database
      .selectFrom('moderation.report_snapshots')
      .selectAll()
      .where('report_id', '=', reportId)
      .execute();
    const evidence = await database
      .selectFrom('moderation.report_evidence')
      .selectAll()
      .where('report_id', '=', reportId)
      .execute();
    const messages = await database
      .selectFrom('chat.chat_messages')
      .selectAll()
      .where('chat_session_id', '=', scope.chatSessionId)
      .execute();
    const lease = await claim();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.closeNext(lease)));
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(results.every((result) => !result.hasMore)).toBe(true);
    expect(await counts(fixture.recordId)).toEqual({ audits: 1, events: 1, notices: 1 });
    expect(
      await database
        .selectFrom('chat.chat_sessions')
        .select(['status', 'closed_reason'])
        .where('id', '=', scope.chatSessionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'closed', closed_reason: 'account_deleted' });
    expect(
      await database
        .selectFrom('interaction.feature_unlocks')
        .select(['status', 'revoked_reason'])
        .where('match_id', '=', scope.matchId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'revoked', revoked_reason: 'account_deleted' });
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('user_id', '=', other)
        .execute(),
    ).toEqual(ledger);
    expect(
      await database
        .selectFrom('moderation.report_snapshots')
        .selectAll()
        .where('report_id', '=', reportId)
        .execute(),
    ).toEqual(snapshots);
    expect(
      await database
        .selectFrom('moderation.report_evidence')
        .selectAll()
        .where('report_id', '=', reportId)
        .execute(),
    ).toEqual(evidence);
    expect(
      await database
        .selectFrom('chat.chat_messages')
        .selectAll()
        .where('chat_session_id', '=', scope.chatSessionId)
        .execute(),
    ).toEqual(messages);
    expect(await store.closeNext(lease)).toEqual({ examined: 0, changed: false, hasMore: false });
    const root = await sql<{
      phase: string;
      reactivation_allowed: boolean;
    }>`SELECT phase,reactivation_allowed FROM identity.account_deletion_records WHERE id=${fixture.recordId}::uuid`.execute(
      database,
    );
    expect(root.rows[0]).toEqual({ phase: 'shared_closure', reactivation_allowed: false });
  });
  it('denies history and prior read/mute receipts immediately after the other account tombstone', async () => {
    const other = await counterpart();
    let scope!: { matchId: string; chatSessionId: string },
      read!: MarkChatReadWrite,
      mute!: ChangeChatMuteWrite;
    const state = new PostgresChatStateStore(database);
    await createDeletionFixture(database, async (owner) => {
      await activeOwner(owner, other);
      scope = await chat(owner, other);
      const common = {
        schemaVersion: 1 as const,
        actor: { kind: 'user' as const, userId: other },
        occurredAt: new Date().toISOString(),
        locale: 'en' as const,
      };
      const token = `v1.ch.${'g'.repeat(16)}.${'h'.repeat(16)}`;
      read = {
        chatSessionId: scope.chatSessionId,
        eventId: randomUUID(),
        command: {
          ...common,
          commandType: 'chat.mark-read',
          commandId: randomUUID(),
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          data: { chatActionToken: token, throughSequenceNumber: '1' },
        },
      };
      mute = {
        chatSessionId: scope.chatSessionId,
        eventId: randomUUID(),
        command: {
          ...common,
          commandType: 'chat.change-mute',
          commandId: randomUUID(),
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          data: { chatActionToken: token, muted: true, expectedVersion: 2 },
        },
      };
      await state.markRead(read);
      await state.changeMute(mute);
      expect(
        (await state.readPage({ userId: other, chatSessionId: scope.chatSessionId, limit: 20 }))
          .items,
      ).toHaveLength(1);
    });
    await expect(
      state.readPage({ userId: other, chatSessionId: scope.chatSessionId, limit: 20 }),
    ).rejects.toMatchObject({ code: 'chat_unavailable' });
    await expect(state.markRead(read)).rejects.toMatchObject({ code: 'chat_unavailable' });
    await expect(state.changeMute(mute)).rejects.toMatchObject({ code: 'chat_unavailable' });
    expect(
      (
        await database
          .selectFrom('chat.chat_sessions')
          .select('status')
          .where('id', '=', scope.chatSessionId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('active');
  });
  it('resumes with a fresh worker after each bounded pair and requires no outbox replay', async () => {
    const others = await Promise.all([counterpart(), counterpart(), counterpart()]);
    const fixture = await createDeletionFixture(database, async (owner) => {
      await activeOwner(owner, others[0]);
      for (const other of others) await chat(owner, other);
    });
    let lease = await claim();
    expect(await store.closeNext(lease)).toMatchObject({
      examined: 1,
      changed: true,
      hasMore: true,
    });
    await work.release(lease);
    await database
      .deleteFrom('platform.outbox_events')
      .where('aggregate_id', '=', fixture.recordId)
      .execute();
    lease = await claim();
    expect(await new PostgresAccountDeletionSharedStore(database).closeNext(lease)).toMatchObject({
      examined: 1,
      changed: true,
      hasMore: true,
    });
    expect(await store.closeNext(lease)).toMatchObject({
      examined: 1,
      changed: true,
      hasMore: false,
    });
    expect(await counts(fixture.recordId)).toEqual({ audits: 3, events: 2, notices: 3 });
    await expect(
      store.closeNext({ ...lease, leaseGeneration: lease.leaseGeneration - 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['audit', 'event', 'notice'] as const)(
    'rolls back closure when the required %s is suppressed',
    async (kind) => {
      const other = await counterpart();
      let scope!: { matchId: string; chatSessionId: string };
      const fixture = await createDeletionFixture(database, async (owner) => {
        await activeOwner(owner, other);
        scope = await chat(owner, other);
      });
      const lease = await claim();
      const table =
        kind === 'audit'
          ? 'platform.audit_logs'
          : kind === 'event'
            ? 'platform.outbox_events'
            : 'notification.notifications';
      await sql
        .raw(
          `CREATE FUNCTION identity.m8_suppress_shared() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${kind === 'notice' ? "NEW.notification_type='chat_closed'" : "NEW.event_type='account.shared-scope-closed.v1'"} THEN RETURN NULL; END IF; RETURN NEW; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER m8_suppress_shared BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_suppress_shared()`,
        )
        .execute(database);
      try {
        await expect(store.closeNext(lease)).rejects.toThrow();
        expect(
          (
            await database
              .selectFrom('chat.chat_sessions')
              .select('status')
              .where('id', '=', scope.chatSessionId)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe('active');
        expect(await counts(fixture.recordId)).toEqual({ audits: 0, events: 0, notices: 0 });
      } finally {
        await sql.raw(`DROP TRIGGER m8_suppress_shared ON ${table}`).execute(database);
        await sql`DROP FUNCTION identity.m8_suppress_shared()`.execute(database);
      }
      expect(await store.closeNext(lease)).toMatchObject({ changed: true, hasMore: false });
    },
  );
  it('closes pending and delivered Nakh once without changing ledger truth or producing reconciliation anomalies', async () => {
    const pendingOther = await counterpart(),
      deliveredOther = await counterpart();
    let pendingId!: string, nakhId!: string;
    const fixture = await createDeletionFixture(database, async (owner) => {
      await activeOwner(owner, pendingOther);
      const common = {
        schemaVersion: 1 as const,
        actor: { kind: 'user' as const, userId: owner },
        occurredAt: new Date().toISOString(),
        locale: 'en' as const,
      };
      const pending = await new PostgresPendingNakhStore(database).createPending({
        command: {
          ...common,
          commandType: 'nakh.create-pending',
          commandId: randomUUID(),
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          data: {
            targetUserId: pendingOther,
            text: 'Synthetic pending hello',
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
      await credit(owner);
      const direct = await new PostgresDirectNakhStore(database).createDirect({
        command: {
          ...common,
          commandType: 'nakh.create-direct',
          commandId: randomUUID(),
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          data: { targetUserId: deliveredOther, text: 'Synthetic funded hello' },
        },
        flowId: randomUUID(),
        nakhId: randomUUID(),
        creditTransactionId: randomUUID(),
        historyId: randomUUID(),
        flowEventId: randomUUID(),
        deliveredEventId: randomUUID(),
      });
      nakhId = direct.nakhId;
    });
    const ledger = await database
      .selectFrom('billing.credit_transactions')
      .selectAll()
      .where('user_id', '=', fixture.userId)
      .execute();
    const lease = await claim();
    await store.closeNext(lease);
    await store.closeNext(lease);
    await store.closeNext(lease);
    expect(
      (
        await database
          .selectFrom('platform.user_counters')
          .select('pending_nakh_count')
          .where('user_id', '=', fixture.userId)
          .executeTakeFirstOrThrow()
      ).pending_nakh_count,
    ).toBe(0);
    expect(
      (
        await database
          .selectFrom('nakh.pending_nakhes')
          .select('status')
          .where('id', '=', pendingId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('closed_by_system');
    expect(
      (
        await database
          .selectFrom('nakh.nakhes')
          .select('status')
          .where('id', '=', nakhId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('closed');
    expect(
      await database
        .selectFrom('nakh.nakh_status_history')
        .select('id')
        .where('nakh_id', '=', nakhId)
        .where('to_status', '=', 'closed')
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .selectAll()
        .where('user_id', '=', fixture.userId)
        .execute(),
    ).toEqual(ledger);
    const reconciliation = new RunNakhReconciliationBatchHandler(
      new PostgresNakhReconciliationStore(database),
    );
    let result = await reconciliation.execute({ proposedRunId: randomUUID(), limit: 500 });
    for (let batch = 0; !result.completed && batch < 20; batch++) {
      result = await reconciliation.execute({ proposedRunId: randomUUID(), limit: 500 });
    }
    expect(result.completed).toBe(true);
    expect(
      await database
        .selectFrom('billing.reconciliation_anomalies')
        .select('id')
        .where('run_id', '=', result.runId)
        .where('entity_id', 'in', [pendingId, nakhId, fixture.userId])
        .execute(),
    ).toEqual([]);
    expect(await counts(fixture.recordId)).toEqual({ audits: 2, events: 2, notices: 0 });
  });
  it('serializes ordinary unmatch with deletion without reopening or duplicating shared closure', async () => {
    const other = await counterpart();
    let scope!: { matchId: string; chatSessionId: string };
    const fixture = await createDeletionFixture(database, async (owner) => {
      await activeOwner(owner, other);
      scope = await chat(owner, other);
    });
    const lease = await claim();
    const unmatch = new PostgresUnmatchStore(database).unmatch({
      matchId: scope.matchId,
      eventId: randomUUID(),
      command: {
        commandType: 'matching.unmatch',
        schemaVersion: 1,
        commandId: randomUUID(),
        actor: { kind: 'user', userId: other },
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          matchActionToken: `v1.mt.${'k'.repeat(16)}.${'l'.repeat(16)}`,
          reasonCode: 'not_a_fit',
        },
      },
    });
    const results = await Promise.allSettled([unmatch, store.closeNext(lease)]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'chat_unavailable' } });
    expect(results[1].status).toBe('fulfilled');
    expect(
      (
        await database
          .selectFrom('chat.chat_sessions')
          .select('status')
          .where('id', '=', scope.chatSessionId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('closed');
    expect((await counts(fixture.recordId)).audits).toBe(1);
    expect(await store.closeNext(lease)).toEqual({ examined: 0, changed: false, hasMore: false });
  });
  it('rejects a lease that expires while waiting for the pair lock without changing shared state', async () => {
    const other = await counterpart();
    let scope!: { matchId: string; chatSessionId: string };
    const fixture = await createDeletionFixture(database, async (owner) => {
      await activeOwner(owner, other);
      scope = await chat(owner, other);
    });
    const lease = await claim(1000);
    let attempt!: Promise<void>;
    await database.transaction().execute(async (tx) => {
      await lockUserPair(tx, fixture.userId, other);
      attempt = expect(store.closeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
      await sql`SELECT pg_sleep(1.2)`.execute(tx);
    });
    await attempt;
    expect(
      (
        await database
          .selectFrom('chat.chat_sessions')
          .select('status')
          .where('id', '=', scope.chatSessionId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('active');
    expect(await counts(fixture.recordId)).toEqual({ audits: 0, events: 0, notices: 0 });
    expect(await store.closeNext(await claim())).toMatchObject({ changed: true, hasMore: false });
  });
  it('preserves a blocked pair and closes a still-active chat on an already-closed match', async () => {
    const other = await counterpart();
    let scope!: { matchId: string; chatSessionId: string };
    const fixture = await createDeletionFixture(database, async (owner) => {
      await activeOwner(owner, other);
      scope = await chat(owner, other);
      await credit(other);
      await new PostgresPaidActionStore(database).spendCredits({
        featureUnlockId: randomUUID(),
        creditTransactionId: randomUUID(),
        outboxEventId: randomUUID(),
        userId: other,
        target: { type: 'match', targetId: scope.matchId },
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      await sql`UPDATE interaction.user_pair_states SET state='blocked',reason_code='safety_block',version=version+1,changed_at=clock_timestamp() WHERE user_low_id=LEAST(${owner}::uuid,${other}::uuid) AND user_high_id=GREATEST(${owner}::uuid,${other}::uuid)`.execute(
        database,
      );
      await sql`UPDATE matching.matches SET status='closed',version=version+1,closed_at=clock_timestamp() WHERE id=${scope.matchId}::uuid`.execute(
        database,
      );
    });
    const before = await database
      .selectFrom('interaction.user_pair_states')
      .selectAll()
      .where('user_low_id', '=', [fixture.userId, other].sort()[0]!)
      .where('user_high_id', '=', [fixture.userId, other].sort()[1]!)
      .executeTakeFirstOrThrow();
    expect(await store.closeNext(await claim())).toMatchObject({ changed: true, hasMore: false });
    expect(
      await database
        .selectFrom('interaction.user_pair_states')
        .selectAll()
        .where('user_low_id', '=', before.user_low_id)
        .where('user_high_id', '=', before.user_high_id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      (
        await database
          .selectFrom('interaction.feature_unlocks')
          .select('status')
          .where('match_id', '=', scope.matchId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('revoked');
    expect(await counts(fixture.recordId)).toEqual({ audits: 1, events: 1, notices: 1 });
  });
});
