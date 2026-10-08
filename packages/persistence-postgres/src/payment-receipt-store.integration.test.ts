import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  CancelPendingNakhWrite,
  CreatePendingNakhWrite,
  EncryptedProviderEvidence,
  ProtectedInvoicePayload,
  TelegramSuccessfulPaymentWrite,
} from '@nakh/application';
import type { CancelPendingNakhCommand, CreatePendingNakhCommand } from '@nakh/contracts';

import { PostgresBillingReconciliationStore } from './billing-reconciliation-store.js';
import { PostgresAccountDeletionStore } from './account-deletion-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresFundingStore } from './funding-store.js';
import { runMigrations } from './migrations.js';
import { PostgresTelegramStarsReceiptStore } from './payment-receipt-store.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';
import { PostgresRefundStore } from './refund-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const botDigest = 'b'.repeat(64);
const ids = { uuid: randomUUID };
const manGenderId = '20000000-0000-4000-8000-000000000001';
const everyonePreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function issuePayload(): ProtectedInvoicePayload {
  const cleartext = randomBytes(24).toString('base64url');
  return {
    cleartext,
    digest: digest(cleartext),
    ciphertext: Uint8Array.from(randomBytes(64)),
    keyId: 'billing-v1',
  };
}

function evidence(seed: string): EncryptedProviderEvidence {
  return {
    digest: digest(seed),
    ciphertext: Uint8Array.from(randomBytes(64)),
    keyId: 'provider-v1',
    schemaVersion: 1,
  };
}

async function createUser(database: NakhDatabase): Promise<{
  userId: string;
  telegramUserId: string;
}> {
  const userId = randomUUID();
  const telegramUserId = String(100_000_000 + Math.floor(Math.random() * 800_000_000));
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({ user_id: userId, state: 'active', state_reason: null, state_changed_at: now })
    .execute();
  await database
    .insertInto('identity.telegram_identities')
    .values({
      user_id: userId,
      telegram_user_id: telegramUserId,
      username: null,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('profile.profiles')
    .values({
      id: randomUUID(),
      user_id: userId,
      name: 'Stars Nakh fixture',
      birth_year: new Date().getUTCFullYear() - 30,
      gender_option_id: manGenderId,
      gender_preference_id: everyonePreferenceId,
      relationship_goal_id: relationshipGoalId,
      country_id: countryId,
      province_id: provinceId,
      city_id: cityId,
      highlight: 'Stars Nakh fixture',
      bio: null,
      completion_status: 'complete',
      ever_completed: true,
      completed_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await database
    .insertInto('billing.credit_accounts')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('notification.notification_preferences')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  return { userId, telegramUserId };
}

function pendingCommand(senderUserId: string, receiverUserId: string): CreatePendingNakhCommand {
  return {
    commandId: randomUUID(),
    commandType: 'nakh.create-pending',
    schemaVersion: 1,
    actor: { kind: 'user', userId: senderUserId },
    requestId: randomUUID(),
    idempotencyKey: `stars-nakh:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: {
      targetUserId: receiverUserId,
      text: 'A captured private hello 🌳',
      autoSettleAuthorized: true,
    },
  };
}

function pendingWrite(command: CreatePendingNakhCommand): CreatePendingNakhWrite {
  return {
    command,
    flowId: randomUUID(),
    pendingNakhId: randomUUID(),
    pendingPaymentId: randomUUID(),
    flowEventId: randomUUID(),
    pendingEventId: randomUUID(),
  };
}

function cancellationWrite(command: CancelPendingNakhCommand): CancelPendingNakhWrite {
  return {
    command,
    interactionId: randomUUID(),
    matchId: randomUUID(),
    chatSessionId: randomUUID(),
    interactionEventId: randomUUID(),
    likeClosedEventId: randomUUID(),
    matchEventId: randomUUID(),
    pendingEventId: randomUUID(),
    auditId: randomUUID(),
  };
}

describe.skipIf(databaseUrl === undefined)('M4 durable Telegram Stars receipts', () => {
  let database: NakhDatabase;
  let funding: PostgresFundingStore;
  let receipts: PostgresTelegramStarsReceiptStore;
  let refunds: PostgresRefundStore;
  let reconciliation: PostgresBillingReconciliationStore;
  let pendingNakhes: PostgresPendingNakhStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 24,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
    });
    funding = new PostgresFundingStore(database);
    receipts = new PostgresTelegramStarsReceiptStore(database, ids, { digest });
    refunds = new PostgresRefundStore(database);
    reconciliation = new PostgresBillingReconciliationStore(database);
    pendingNakhes = new PostgresPendingNakhStore(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  async function preparedPayment(): Promise<{
    paymentRecordId: string;
    userId: string;
    telegramUserId: string;
    payload: ProtectedInvoicePayload;
    starsAmount: bigint;
  }> {
    const user = await createUser(database);
    return preparePaymentFor(user, { type: 'credit_package', packageCode: 'starter' });
  }

  async function deletePayer(userId: string): Promise<void> {
    const account = await database
      .selectFrom('identity.accounts')
      .select('version')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    const key = randomBytes(32);
    const deletion = new PostgresAccountDeletionStore(database, {
      activeKeyId: 'payment-lifecycle-test',
      keys: new Map([['payment-lifecycle-test', key]]),
    });
    try {
      const proof = await deletion.prepare({
        actor: { kind: 'user', userId },
        requestId: randomUUID(),
        expectedAccountVersion: account.version,
      });
      const commandId = randomUUID();
      await deletion.request({
        commandId,
        commandType: 'account.delete',
        schemaVersion: 1,
        actor: { kind: 'user', userId },
        requestId: randomUUID(),
        idempotencyKey: `package-delete:${commandId}`,
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
  }

  async function capturedPackage(deleteBeforeCapture = false): Promise<{
    payment: Awaited<ReturnType<typeof preparedPayment>>;
    callback: TelegramSuccessfulPaymentWrite;
    fulfillment: Parameters<PostgresTelegramStarsReceiptStore['fulfillCreditPackage']>[0];
  }> {
    const payment = await preparedPayment();
    if (deleteBeforeCapture) await deletePayer(payment.userId);
    const eventId = `package-captured:${randomUUID()}`;
    const callback: TelegramSuccessfulPaymentWrite = {
      providerEventId: eventId,
      telegramUserId: payment.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      telegramChargeId: `telegram:${randomUUID()}`,
      evidence: evidence(eventId),
    };
    await receipts.recordSuccessfulPayment(callback);
    const owner = `epoch-worker:${randomUUID()}`;
    const claim = (await receipts.claimFulfillments({ owner, leaseMs: 60_000, limit: 100 })).find(
      ({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId,
    )!;
    expect(claim).toBeDefined();
    return {
      payment,
      callback,
      fulfillment: {
        paymentRecordId: payment.paymentRecordId,
        owner,
        fenceToken: claim.fenceToken,
        creditTransactionId: randomUUID(),
        creditIncreasedEventId: randomUUID(),
        paymentFulfilledEventId: randomUUID(),
        refundRecordId: randomUUID(),
      },
    };
  }

  it('corrects one captured package after real deletion across competing workers and provider replay', async () => {
    const { payment, callback, fulfillment } = await capturedPackage(true);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => receipts.fulfillCreditPackage(fulfillment)),
    );
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(results.every(({ outcome }) => outcome === 'correction_required')).toBe(true);
    expect(
      await database
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version'])
        .where('user_id', '=', payment.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ balance: '0', version: 1 });
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .select('id')
        .where('payment_record_id', '=', payment.paymentRecordId)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('billing.refund_records')
        .select(['id', 'user_id', 'telegram_charge_id', 'stars_amount', 'reason_code'])
        .where('payment_record_id', '=', payment.paymentRecordId)
        .execute(),
    ).toEqual([
      {
        id: fulfillment.refundRecordId,
        user_id: payment.userId,
        telegram_charge_id: callback.telegramChargeId,
        stars_amount: payment.starsAmount.toString(),
        reason_code: 'target_unavailable',
      },
    ]);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('id')
        .where('user_id', '=', payment.userId)
        .where('notification_type', '=', 'payment_success')
        .execute(),
    ).toEqual([]);
    await receipts.recordSuccessfulPayment(callback);
    await receipts.recordSuccessfulPayment({
      ...callback,
      providerEventId: `captured-replay:${randomUUID()}`,
    });
    await expect(
      receipts.fulfillCreditPackage({ ...fulfillment, refundRecordId: randomUUID() }),
    ).resolves.toMatchObject({
      outcome: 'correction_required',
      refundRecordId: fulfillment.refundRecordId,
      replayed: true,
    });
    const refund = (
      await refunds.claimStarsRefunds({ owner: fulfillment.owner, leaseMs: 60_000, limit: 100 })
    ).find(({ refundRecordId }) => refundRecordId === fulfillment.refundRecordId)!;
    expect(refund).toMatchObject({
      userId: payment.userId,
      telegramChargeId: callback.telegramChargeId,
      starsAmount: payment.starsAmount,
    });
    await expect(refunds.beginProviderCall(refund)).resolves.toBe(true);
    await expect(refunds.completeStarsRefund(refund)).resolves.toBe('processed');
    await expect(refunds.completeStarsRefund(refund)).resolves.toBe('replayed');
  });

  it('denies a cached checkout and invoice after deletion without rewriting historical provider authority', async () => {
    const payment = await preparedPayment();
    const eventId = `epoch-checkout:${randomUUID()}`;
    const write = {
      providerEventId: eventId,
      telegramUserId: payment.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test' as const,
      providerBotIdDigest: botDigest,
      evidence: evidence(eventId),
    };
    await expect(receipts.validatePreCheckout(write)).resolves.toEqual({
      allowed: true,
      replayed: false,
    });
    const attempt = await database
      .selectFrom('billing.payment_records')
      .select(['pending_payment_id', 'idempotency_key'])
      .where('id', '=', payment.paymentRecordId)
      .executeTakeFirstOrThrow();
    await deletePayer(payment.userId);
    await expect(receipts.validatePreCheckout(write)).resolves.toEqual({
      allowed: false,
      reasonCode: 'target_unavailable',
      replayed: true,
    });
    await expect(
      receipts.validatePreCheckout({ ...write, providerEventId: `epoch-new:${randomUUID()}` }),
    ).resolves.toMatchObject({ allowed: false, reasonCode: 'target_unavailable', replayed: false });
    expect(
      await database
        .selectFrom('billing.payment_provider_events')
        .select('decision')
        .where('provider_event_id', '=', eventId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ decision: 'allow' });
    await expect(
      funding.prepareStarsAttempt({
        paymentRecordId: randomUUID(),
        fundingIntentId: attempt.pending_payment_id,
        userId: payment.userId,
        expectedVersion: 1,
        idempotencyKey: attempt.idempotency_key,
        providerEnvironment: 'test',
        providerBotIdDigest: botDigest,
        payload: issuePayload(),
      }),
    ).rejects.toMatchObject({ code: 'capability_denied' });
    // Captured money is still recorded after deletion, even though checkout is no longer authorized.
    await expect(
      receipts.recordSuccessfulPayment({
        ...write,
        providerEventId: `late-capture:${randomUUID()}`,
        telegramChargeId: `telegram:${randomUUID()}`,
      }),
    ).resolves.toMatchObject({ outcome: 'receipt_recorded' });
  });

  it('rejects fabricated account and payment epochs and an unverified return', async () => {
    const payment = await preparedPayment();
    const attempt = await database
      .selectFrom('billing.payment_records')
      .select('pending_payment_id')
      .where('id', '=', payment.paymentRecordId)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .updateTable('billing.pending_payments')
        .set({ product_epoch: 1, status: 'cancelled', version: 2, resolved_at: new Date() })
        .where('id', '=', attempt.pending_payment_id)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database
        .updateTable('identity.accounts')
        .set({ product_epoch: 1 })
        .where('user_id', '=', payment.userId)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      database.deleteFrom('identity.accounts').where('user_id', '=', payment.userId).execute(),
    ).rejects.toMatchObject({ code: '55000' });
    await deletePayer(payment.userId);
    const originalIntent = await database
      .selectFrom('billing.pending_payments')
      .selectAll()
      .where('id', '=', attempt.pending_payment_id)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .insertInto('billing.pending_payments')
        .values({
          ...originalIntent,
          id: randomUUID(),
          idempotency_key: `deleted-admission:${randomUUID()}`,
        })
        .execute(),
    ).rejects.toMatchObject({ code: '40001' });
    await expect(
      database
        .updateTable('identity.accounts')
        .set({ state: 'guest', product_epoch: 1, version: 3 })
        .where('user_id', '=', payment.userId)
        .execute(),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('corrects a captured package after waiting behind a real committing tombstone', async () => {
    const { payment, fulfillment } = await capturedPackage();
    await sql
      .raw(
        `CREATE FUNCTION identity.test_package_tombstone_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id='${payment.userId}'::uuid AND NEW.state='deleted' THEN
        PERFORM pg_advisory_xact_lock(410097,1); END IF; RETURN NEW; END $$`,
      )
      .execute(database);
    await sql`CREATE TRIGGER test_package_tombstone_wait AFTER UPDATE ON identity.accounts
      FOR EACH ROW EXECUTE FUNCTION identity.test_package_tombstone_wait()`.execute(database);
    let deletion: Promise<boolean> | undefined;
    let result: ReturnType<typeof receipts.fulfillCreditPackage> | undefined;
    async function waitForLock(kind: 'deletion' | 'worker'): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting =
          kind === 'deletion'
            ? await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_locks
              WHERE locktype='advisory' AND classid=410097 AND objid=1 AND NOT granted) AS waiting`.execute(
                database,
              )
            : await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%for no key update%') AS waiting`.execute(
                database,
              );
        if (waiting.rows[0]!.waiting) return;
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
      }
      throw new Error('Expected canonical lifecycle lock was not observed');
    }
    try {
      await database.transaction().execute(async (barrier) => {
        await sql`SELECT pg_advisory_xact_lock(410097,1)`.execute(barrier);
        deletion = deletePayer(payment.userId).then(
          () => true,
          () => false,
        );
        await waitForLock('deletion');
        result = receipts.fulfillCreditPackage(fulfillment);
        await waitForLock('worker');
      });
      expect(await deletion).toBe(true);
      await expect(result).resolves.toMatchObject({
        outcome: 'correction_required',
        replayed: false,
      });
      expect(
        await database
          .selectFrom('billing.credit_transactions')
          .select('id')
          .where('payment_record_id', '=', payment.paymentRecordId)
          .execute(),
      ).toEqual([]);
    } finally {
      await deletion;
      await result?.catch(() => undefined);
      await sql`DROP TRIGGER test_package_tombstone_wait ON identity.accounts`.execute(database);
      await sql`DROP FUNCTION identity.test_package_tombstone_wait()`.execute(database);
    }
  });

  it('uses the current clock after waiting for the canonical payer lock', async () => {
    const { payment, fulfillment } = await capturedPackage();
    await database
      .updateTable('billing.payment_fulfillments')
      .set((eb) => ({
        lease_expires_at: sql<Date>`clock_timestamp()+interval '700 milliseconds'`,
        version: eb('version', '+', 1),
      }))
      .where('payment_record_id', '=', payment.paymentRecordId)
      .execute();
    let finished: Promise<unknown> | undefined;
    await database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', payment.userId)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', payment.userId)
        .forUpdate()
        .execute();
      finished = expect(receipts.fulfillCreditPackage(fulfillment)).rejects.toMatchObject({
        code: 'conflict',
      });
      await sql`SELECT pg_sleep(1.1)`.execute(transaction);
    });
    await finished;
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .select('id')
        .where('payment_record_id', '=', payment.paymentRecordId)
        .execute(),
    ).toEqual([]);
    const claim = (
      await receipts.claimFulfillments({ owner: fulfillment.owner, leaseMs: 60_000, limit: 100 })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId)!;
    expect(claim.fenceToken).toBe(fulfillment.fenceToken + 1n);
    await expect(receipts.fulfillCreditPackage(fulfillment)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      receipts.fulfillCreditPackage({ ...fulfillment, fenceToken: claim.fenceToken }),
    ).resolves.toMatchObject({ outcome: 'fulfilled', balanceAfter: 10n, replayed: false });
  });

  it('rolls back a package grant whose lease expires during deferred commit checks', async () => {
    const { payment, fulfillment } = await capturedPackage();
    await database
      .updateTable('billing.payment_fulfillments')
      .set((eb) => ({
        lease_expires_at: sql<Date>`clock_timestamp()+interval '700 milliseconds'`,
        version: eb('version', '+', 1),
      }))
      .where('payment_record_id', '=', payment.paymentRecordId)
      .execute();
    await sql
      .raw(
        `CREATE FUNCTION billing.test_package_commit_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.payment_record_id='${payment.paymentRecordId}'::uuid AND NEW.state='fulfilled'
        THEN PERFORM pg_sleep(1.1); END IF; RETURN NULL; END $$`,
      )
      .execute(database);
    await sql`CREATE CONSTRAINT TRIGGER aaa_package_commit_wait AFTER UPDATE ON billing.payment_fulfillments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.test_package_commit_wait()`.execute(
      database,
    );
    try {
      await expect(receipts.fulfillCreditPackage(fulfillment)).rejects.toMatchObject({
        code: '23514',
      });
      expect(
        await database
          .selectFrom('billing.credit_accounts')
          .select(['balance', 'version'])
          .where('user_id', '=', payment.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ balance: '0', version: 1 });
      expect(
        await database
          .selectFrom('billing.credit_transactions')
          .select('id')
          .where('payment_record_id', '=', payment.paymentRecordId)
          .execute(),
      ).toEqual([]);
      expect(
        await database
          .selectFrom('platform.outbox_events')
          .select('id')
          .where('id', 'in', [
            fulfillment.creditIncreasedEventId,
            fulfillment.paymentFulfilledEventId,
          ])
          .execute(),
      ).toEqual([]);
    } finally {
      await sql`DROP TRIGGER aaa_package_commit_wait ON billing.payment_fulfillments`.execute(
        database,
      );
      await sql`DROP FUNCTION billing.test_package_commit_wait()`.execute(database);
    }
    const claim = (
      await receipts.claimFulfillments({ owner: fulfillment.owner, leaseMs: 60_000, limit: 100 })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId)!;
    await expect(
      receipts.fulfillCreditPackage({ ...fulfillment, fenceToken: claim.fenceToken }),
    ).resolves.toMatchObject({ outcome: 'fulfilled', balanceAfter: 10n });
  });

  it.each(['refund', 'event'] as const)(
    'rolls back package correction when its required %s is suppressed',
    async (missing) => {
      const { payment, fulfillment } = await capturedPackage();
      await deletePayer(payment.userId);
      const target = missing === 'refund' ? 'billing.refund_records' : 'platform.outbox_events';
      // Test-only suppression proves the deferred guard checks committed facts, not application intentions.
      await sql
        .raw(
          `CREATE FUNCTION billing.test_package_suppression() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${missing === 'refund' ? 'NEW.payment_record_id' : 'NEW.aggregate_id'}='${payment.paymentRecordId}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER test_package_suppression BEFORE INSERT ON ${target}
      FOR EACH ROW EXECUTE FUNCTION billing.test_package_suppression()`,
        )
        .execute(database);
      try {
        await expect(receipts.fulfillCreditPackage(fulfillment)).rejects.toMatchObject({
          code: '23514',
        });
        expect(
          await database
            .selectFrom('billing.payment_fulfillments')
            .select('state')
            .where('payment_record_id', '=', payment.paymentRecordId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ state: 'fulfillment_pending' });
        expect(
          await database
            .selectFrom('billing.refund_records')
            .select('id')
            .where('payment_record_id', '=', payment.paymentRecordId)
            .execute(),
        ).toEqual([]);
      } finally {
        await sql.raw(`DROP TRIGGER test_package_suppression ON ${target}`).execute(database);
        await sql`DROP FUNCTION billing.test_package_suppression()`.execute(database);
      }
      await expect(receipts.fulfillCreditPackage(fulfillment)).resolves.toMatchObject({
        outcome: 'correction_required',
        replayed: false,
      });
    },
  );

  async function preparePaymentFor(
    user: Readonly<{ userId: string; telegramUserId: string }>,
    target:
      | Readonly<{ type: 'credit_package'; packageCode: 'starter' }>
      | Readonly<{ type: 'match'; targetId: string }>,
  ): Promise<{
    paymentRecordId: string;
    userId: string;
    telegramUserId: string;
    payload: ProtectedInvoicePayload;
    starsAmount: bigint;
  }> {
    const intent = await funding.createFundingIntent({
      intentId: randomUUID(),
      userId: user.userId,
      funding: 'stars',
      target,
      idempotencyKey: `receipt-intent:${randomUUID()}`,
    });
    const payload = issuePayload();
    const attempt = await funding.prepareStarsAttempt({
      paymentRecordId: randomUUID(),
      fundingIntentId: intent.id,
      expectedVersion: 1,
      userId: user.userId,
      idempotencyKey: `receipt-attempt:${randomUUID()}`,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      payload,
    });
    return {
      paymentRecordId: attempt.paymentRecordId,
      userId: user.userId,
      telegramUserId: user.telegramUserId,
      payload,
      starsAmount: attempt.starsAmount,
    };
  }

  async function preparePendingNakhPayment(): Promise<{
    sender: Readonly<{ userId: string; telegramUserId: string }>;
    receiver: Readonly<{ userId: string; telegramUserId: string }>;
    pendingNakhId: string;
    fundingIntentId: string;
    paymentRecordId: string;
    payload: ProtectedInvoicePayload;
    starsAmount: bigint;
  }> {
    const sender = await createUser(database);
    const receiver = await createUser(database);
    const created = await pendingNakhes.createPending(
      pendingWrite(pendingCommand(sender.userId, receiver.userId)),
    );
    const payload = issuePayload();
    const attempt = await funding.prepareStarsAttempt({
      paymentRecordId: randomUUID(),
      fundingIntentId: created.fundingIntentId,
      expectedVersion: 1,
      userId: sender.userId,
      idempotencyKey: `nakh-invoice:${randomUUID()}`,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      payload,
    });
    return {
      sender,
      receiver,
      pendingNakhId: created.pendingNakhId,
      fundingIntentId: created.fundingIntentId,
      paymentRecordId: attempt.paymentRecordId,
      payload,
      starsAmount: attempt.starsAmount,
    };
  }

  async function createActiveMatch(firstUserId: string, secondUserId: string): Promise<string> {
    const [userLowId, userHighId] = [firstUserId, secondUserId].sort();
    const firstLikeId = randomUUID();
    const secondLikeId = randomUUID();
    const matchId = randomUUID();
    const chatSessionId = randomUUID();
    const now = new Date();
    await database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('interaction.likes')
        .values([
          {
            id: firstLikeId,
            sender_user_id: firstUserId,
            receiver_user_id: secondUserId,
            status: 'closed_by_match',
            created_at: now,
            closed_at: now,
          },
          {
            id: secondLikeId,
            sender_user_id: secondUserId,
            receiver_user_id: firstUserId,
            status: 'closed_by_match',
            created_at: now,
            closed_at: now,
          },
        ])
        .execute();
      await transaction
        .insertInto('interaction.user_pair_states')
        .values({
          user_low_id: userLowId!,
          user_high_id: userHighId!,
          state: 'matched',
          reason_code: 'mutual_like',
          changed_at: now,
        })
        .execute();
      await transaction
        .insertInto('matching.matches')
        .values({
          id: matchId,
          user_low_id: userLowId!,
          user_high_id: userHighId!,
          source: 'mutual_like',
          source_like_a_id: firstLikeId,
          source_like_b_id: secondLikeId,
          source_nakh_id: null,
          status: 'active',
          created_at: now,
          closed_at: null,
        })
        .execute();
      await transaction
        .insertInto('matching.match_participants')
        .values([
          { match_id: matchId, user_id: firstUserId, joined_at: now },
          { match_id: matchId, user_id: secondUserId, joined_at: now },
        ])
        .execute();
      await transaction
        .insertInto('chat.chat_sessions')
        .values({
          id: chatSessionId,
          match_id: matchId,
          status: 'active',
          created_at: now,
          closed_at: null,
          closed_reason: null,
        })
        .execute();
      await transaction
        .insertInto('chat.chat_participants')
        .values([
          {
            chat_session_id: chatSessionId,
            user_id: firstUserId,
            last_read_at: null,
            muted_at: null,
            unlock_safety_warning_shown_at: null,
          },
          {
            chat_session_id: chatSessionId,
            user_id: secondUserId,
            last_read_at: null,
            muted_at: null,
            unlock_safety_warning_shown_at: null,
          },
        ])
        .execute();
    });
    return matchId;
  }

  it('persists and replays a strict pre-checkout decision while quarantining changed facts', async () => {
    const payment = await preparedPayment();
    const eventId = `pre-checkout:${randomUUID()}`;
    const write = {
      providerEventId: eventId,
      telegramUserId: payment.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test' as const,
      providerBotIdDigest: botDigest,
      evidence: evidence(eventId),
    };
    await expect(receipts.validatePreCheckout(write)).resolves.toEqual({
      allowed: true,
      replayed: false,
    });
    await expect(receipts.validatePreCheckout(write)).resolves.toEqual({
      allowed: true,
      replayed: true,
    });
    await expect(
      receipts.validatePreCheckout({ ...write, totalAmount: payment.starsAmount + 1n }),
    ).resolves.toEqual({ allowed: false, reasonCode: 'callback_conflict', replayed: true });
    expect(
      await database
        .selectFrom('billing.payment_provider_events')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('provider_event_id', '=', eventId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '1' });
    expect(
      await database
        .selectFrom('billing.payment_provider_conflicts')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('provider_event_id', '=', eventId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '1' });
  });

  it('records one receipt and one fulfillment when the same callback arrives 100 times', async () => {
    const payment = await preparedPayment();
    const eventId = `successful-payment:${randomUUID()}`;
    const write: TelegramSuccessfulPaymentWrite = {
      providerEventId: eventId,
      telegramUserId: payment.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      telegramChargeId: `telegram:${randomUUID()}`,
      providerChargeId: `provider:${randomUUID()}`,
      evidence: evidence(eventId),
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => receipts.recordSuccessfulPayment(write)),
    );
    expect(results.filter(({ outcome }) => outcome === 'receipt_recorded')).toHaveLength(1);
    expect(results.filter(({ outcome }) => outcome === 'replayed')).toHaveLength(99);
    expect(
      await database
        .selectFrom('billing.telegram_stars_receipts')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('payment_record_id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '1' });
    expect(
      await database
        .selectFrom('billing.payment_fulfillments')
        .select(['state', 'attempt_count', 'fence_token'])
        .where('payment_record_id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'receipt_recorded', attempt_count: 0, fence_token: '0' });
    expect(
      await database
        .selectFrom('billing.payment_records')
        .select(['status', 'provider_payment_id'])
        .where('id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'paid', provider_payment_id: write.telegramChargeId });

    const claimed = (
      await receipts.claimFulfillments({ owner: 'package-worker', leaseMs: 60_000, limit: 100 })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId);
    expect(claimed).toBeDefined();
    expect(claimed?.paymentType).toBe('buy_credit_package');
    const fulfillmentWrite = {
      paymentRecordId: payment.paymentRecordId,
      owner: 'package-worker',
      fenceToken: claimed!.fenceToken,
      creditTransactionId: randomUUID(),
      creditIncreasedEventId: randomUUID(),
      paymentFulfilledEventId: randomUUID(),
      refundRecordId: randomUUID(),
    };
    const fulfillments = await Promise.all(
      Array.from({ length: 20 }, () => receipts.fulfillCreditPackage(fulfillmentWrite)),
    );
    expect(fulfillments.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(fulfillments.filter(({ replayed }) => replayed)).toHaveLength(19);
    expect(
      await database
        .selectFrom('billing.credit_accounts')
        .select(['balance', 'version'])
        .where('user_id', '=', payment.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ balance: '10', version: 2 });
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('payment_record_id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '1' });
    expect(
      await database
        .selectFrom('notification.notifications')
        .select(['notification_type', 'category'])
        .where('user_id', '=', payment.userId)
        .where('notification_type', '=', 'payment_success')
        .executeTakeFirstOrThrow(),
    ).toEqual({ notification_type: 'payment_success', category: 'payment' });
  });

  it('ACC-025 delivers one Stars-funded Pending Nakh across callback and worker replays', async () => {
    const payment = await preparePendingNakhPayment();
    const preCheckoutId = `nakh-pre-checkout:${randomUUID()}`;
    await expect(
      receipts.validatePreCheckout({
        providerEventId: preCheckoutId,
        telegramUserId: payment.sender.telegramUserId,
        invoicePayload: payment.payload.cleartext,
        currency: 'XTR',
        totalAmount: payment.starsAmount,
        providerEnvironment: 'test',
        providerBotIdDigest: botDigest,
        evidence: evidence(preCheckoutId),
      }),
    ).resolves.toEqual({ allowed: true, replayed: false });

    const callbackId = `nakh-success:${randomUUID()}`;
    const callback: TelegramSuccessfulPaymentWrite = {
      providerEventId: callbackId,
      telegramUserId: payment.sender.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      telegramChargeId: `telegram:${randomUUID()}`,
      providerChargeId: `provider:${randomUUID()}`,
      evidence: evidence(callbackId),
    };
    const callbacks = await Promise.all(
      Array.from({ length: 100 }, () => receipts.recordSuccessfulPayment(callback)),
    );
    expect(callbacks.filter(({ outcome }) => outcome === 'receipt_recorded')).toHaveLength(1);
    expect(callbacks.filter(({ outcome }) => outcome === 'replayed')).toHaveLength(99);

    const claim = (
      await receipts.claimFulfillments({ owner: 'nakh-worker', leaseMs: 60_000, limit: 100 })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId);
    expect(claim).toBeDefined();
    expect(claim?.paymentType).toBe('pay_pending_action');
    const write = {
      paymentRecordId: payment.paymentRecordId,
      owner: 'nakh-worker',
      fenceToken: claim!.fenceToken,
      nakhId: randomUUID(),
      historyId: randomUUID(),
      refundRecordId: randomUUID(),
      deliveredEventId: randomUUID(),
      paymentTerminalEventId: randomUUID(),
    };
    const fulfilled = await Promise.all(
      Array.from({ length: 20 }, () => receipts.fulfillPendingNakh(write)),
    );
    expect(fulfilled.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(fulfilled.filter(({ replayed }) => replayed)).toHaveLength(19);
    expect(new Set(fulfilled.map(({ nakhId }) => nakhId))).toEqual(new Set([write.nakhId]));

    const [pending, intent, paymentRecord, delivered, history, counter, receiverFacts] =
      await Promise.all([
        database
          .selectFrom('nakh.pending_nakhes')
          .select(['status', 'paid_at', 'version'])
          .where('id', '=', payment.pendingNakhId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('billing.pending_payments')
          .select(['status', 'version'])
          .where('id', '=', payment.fundingIntentId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('billing.payment_records')
          .select(['payment_type', 'paid_action_reason', 'status'])
          .where('id', '=', payment.paymentRecordId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('nakh.nakhes')
          .selectAll()
          .where('payment_record_id', '=', payment.paymentRecordId)
          .execute(),
        database
          .selectFrom('nakh.nakh_status_history')
          .select(['to_status', 'reason_code'])
          .where('nakh_id', '=', write.nakhId)
          .execute(),
        database
          .selectFrom('platform.user_counters')
          .select('pending_nakh_count')
          .where('user_id', '=', payment.sender.userId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('notification.notifications')
          .select(['notification_type', 'user_id'])
          .where('notification_type', '=', 'nakh_received')
          .where('user_id', '=', payment.receiver.userId)
          .execute(),
      ]);
    expect(pending.status).toBe('paid_and_sent');
    expect(pending.paid_at).toBeInstanceOf(Date);
    expect(pending.version).toBe(2);
    expect(intent).toEqual({ status: 'paid', version: 2 });
    expect(paymentRecord).toEqual({
      payment_type: 'pay_pending_action',
      paid_action_reason: 'send_nakh',
      status: 'paid',
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      id: write.nakhId,
      text: 'A captured private hello 🌳',
      funding_type: 'telegram_stars',
      status: 'sent',
    });
    expect(history).toEqual([{ to_status: 'sent', reason_code: 'telegram_stars_funded' }]);
    expect(counter.pending_nakh_count).toBe(0);
    expect(receiverFacts).toEqual([
      { notification_type: 'nakh_received', user_id: payment.receiver.userId },
    ]);
  });

  it('creates one correction when the pair becomes terminal after Stars capture', async () => {
    const payment = await preparePendingNakhPayment();
    const callbackId = `nakh-invalid:${randomUUID()}`;
    await receipts.recordSuccessfulPayment({
      providerEventId: callbackId,
      telegramUserId: payment.sender.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      telegramChargeId: `telegram:${randomUUID()}`,
      evidence: evidence(callbackId),
    });
    const [userLowId, userHighId] = [payment.sender.userId, payment.receiver.userId].sort();
    await database
      .insertInto('interaction.user_pair_states')
      .values({
        user_low_id: userLowId!,
        user_high_id: userHighId!,
        state: 'blocked',
        reason_code: 'safety_block',
        changed_at: new Date(),
      })
      .execute();
    const claim = (
      await receipts.claimFulfillments({ owner: 'nakh-correction', leaseMs: 60_000, limit: 100 })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId);
    expect(claim).toBeDefined();
    expect(claim?.paymentType).toBe('pay_pending_action');
    const write = {
      paymentRecordId: payment.paymentRecordId,
      owner: 'nakh-correction',
      fenceToken: claim!.fenceToken,
      nakhId: randomUUID(),
      historyId: randomUUID(),
      refundRecordId: randomUUID(),
      deliveredEventId: randomUUID(),
      paymentTerminalEventId: randomUUID(),
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => receipts.fulfillPendingNakh(write)),
    );
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(19);
    expect(new Set(results.map(({ refundRecordId }) => refundRecordId))).toEqual(
      new Set([write.refundRecordId]),
    );
    const [pending, refund, fulfillment, delivered, receiverFacts, counter] = await Promise.all([
      database
        .selectFrom('nakh.pending_nakhes')
        .select(['status', 'closed_at', 'version'])
        .where('id', '=', payment.pendingNakhId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('billing.refund_records')
        .select(['id', 'status', 'reason_code'])
        .where('payment_record_id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('billing.payment_fulfillments')
        .select('state')
        .where('payment_record_id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom('nakh.nakhes')
        .select('id')
        .where('payment_record_id', '=', payment.paymentRecordId)
        .execute(),
      database
        .selectFrom('notification.notifications')
        .select('id')
        .where('notification_type', '=', 'nakh_received')
        .where('user_id', '=', payment.receiver.userId)
        .execute(),
      database
        .selectFrom('platform.user_counters')
        .select('pending_nakh_count')
        .where('user_id', '=', payment.sender.userId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(pending.status).toBe('closed_by_system');
    expect(pending.closed_at).toBeInstanceOf(Date);
    expect(pending.version).toBe(2);
    expect(refund).toEqual({
      id: write.refundRecordId,
      status: 'pending',
      reason_code: 'target_unavailable',
    });
    expect(fulfillment.state).toBe('correction_required');
    expect(delivered).toHaveLength(0);
    expect(receiverFacts).toHaveLength(0);
    expect(counter.pending_nakh_count).toBe(0);
  });

  it('ACC-027 refunds a late capture after cancellation without delivering a Nakh', async () => {
    const payment = await preparePendingNakhPayment();
    const cancellation: CancelPendingNakhCommand = {
      commandId: randomUUID(),
      commandType: 'nakh.cancel-pending',
      schemaVersion: 1,
      actor: { kind: 'user', userId: payment.sender.userId },
      requestId: randomUUID(),
      idempotencyKey: `cancel-before-capture:${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        pendingNakhId: payment.pendingNakhId,
        resolution: 'converted_to_not_interested',
        expectedVersion: 1,
      },
    };
    await pendingNakhes.cancelPending(cancellationWrite(cancellation));
    const callbackId = `late-capture:${randomUUID()}`;
    const callback: TelegramSuccessfulPaymentWrite = {
      providerEventId: callbackId,
      telegramUserId: payment.sender.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      telegramChargeId: `telegram:${randomUUID()}`,
      evidence: evidence(callbackId),
    };
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => receipts.recordSuccessfulPayment(callback)),
    );
    expect(outcomes.filter(({ outcome }) => outcome === 'receipt_recorded')).toHaveLength(1);
    expect(outcomes.filter(({ outcome }) => outcome === 'replayed')).toHaveLength(19);
    const [pending, intent, invoice, fulfillment, refundsFound, delivered, receiverFacts] =
      await Promise.all([
        database
          .selectFrom('nakh.pending_nakhes')
          .select(['status', 'cancel_resolution'])
          .where('id', '=', payment.pendingNakhId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('billing.pending_payments')
          .select('status')
          .where('id', '=', payment.fundingIntentId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('billing.payment_records')
          .select('status')
          .where('id', '=', payment.paymentRecordId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('billing.payment_fulfillments')
          .select('state')
          .where('payment_record_id', '=', payment.paymentRecordId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom('billing.refund_records')
          .select('id')
          .where('payment_record_id', '=', payment.paymentRecordId)
          .execute(),
        database
          .selectFrom('nakh.nakhes')
          .select('id')
          .where('payment_record_id', '=', payment.paymentRecordId)
          .execute(),
        database
          .selectFrom('notification.notifications')
          .select('id')
          .where('notification_type', '=', 'nakh_received')
          .where('user_id', '=', payment.receiver.userId)
          .execute(),
      ]);
    expect(pending).toEqual({
      status: 'cancelled',
      cancel_resolution: 'converted_to_not_interested',
    });
    expect(intent.status).toBe('cancelled');
    expect(invoice.status).toBe('paid');
    expect(fulfillment.state).toBe('correction_required');
    expect(refundsFound).toHaveLength(1);
    expect(delivered).toHaveLength(0);
    expect(receiverFacts).toHaveLength(0);
  });

  it('never grants on wrong payment facts and fences a former fulfillment owner', async () => {
    const payment = await preparedPayment();
    const base: TelegramSuccessfulPaymentWrite = {
      providerEventId: `wrong-payment:${randomUUID()}`,
      telegramUserId: payment.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount + 1n,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      telegramChargeId: `telegram:${randomUUID()}`,
      evidence: evidence('wrong-payment'),
    };
    await expect(receipts.recordSuccessfulPayment(base)).resolves.toEqual({
      outcome: 'quarantined',
      reasonCode: 'payment_fact_mismatch',
    });
    expect(
      await database
        .selectFrom('billing.payment_fulfillments')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('payment_record_id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '0' });

    const accepted = {
      ...base,
      providerEventId: `accepted:${randomUUID()}`,
      totalAmount: payment.starsAmount,
    };
    await expect(receipts.recordSuccessfulPayment(accepted)).resolves.toMatchObject({
      outcome: 'receipt_recorded',
    });
    const first = (
      await receipts.claimFulfillments({ owner: 'worker-a', leaseMs: 60_000, limit: 100 })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId);
    expect(first).toBeDefined();
    expect(
      await receipts.releaseFulfillmentForRetry({
        paymentRecordId: payment.paymentRecordId,
        owner: 'worker-a',
        fenceToken: first!.fenceToken,
        errorCode: 'retryable_failure',
        delayMs: 0,
      }),
    ).toBe(true);
    const second = (
      await receipts.claimFulfillments({ owner: 'worker-b', leaseMs: 60_000, limit: 100 })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId);
    expect(second?.fenceToken).toBe(first!.fenceToken + 1n);
    expect(
      await receipts.releaseFulfillmentForRetry({
        paymentRecordId: payment.paymentRecordId,
        owner: 'worker-a',
        fenceToken: first!.fenceToken,
        errorCode: 'stale_worker',
        delayMs: 0,
      }),
    ).toBe(false);
  });

  it('fulfills a direct Stars Match unlock once without touching either credit balance', async () => {
    const payer = await createUser(database);
    const other = await createUser(database);
    const matchId = await createActiveMatch(payer.userId, other.userId);
    const payment = await preparePaymentFor(payer, { type: 'match', targetId: matchId });
    const eventId = `direct-payment:${randomUUID()}`;
    await receipts.recordSuccessfulPayment({
      providerEventId: eventId,
      telegramUserId: payer.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      telegramChargeId: `telegram:${randomUUID()}`,
      evidence: evidence(eventId),
    });
    const claim = (
      await receipts.claimFulfillments({ owner: 'direct-worker', leaseMs: 60_000, limit: 100 })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId);
    expect(claim).toBeDefined();
    expect(claim?.paymentType).toBe('direct_paid_action');
    const fulfillmentWrite = {
      paymentRecordId: payment.paymentRecordId,
      owner: 'direct-worker',
      fenceToken: claim!.fenceToken,
      featureUnlockId: randomUUID(),
      refundRecordId: randomUUID(),
      featureUnlockedEventId: randomUUID(),
      paymentTerminalEventId: randomUUID(),
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => receipts.fulfillDirectPaidAction(fulfillmentWrite)),
    );
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(19);
    expect(new Set(results.map(({ featureUnlockId }) => featureUnlockId))).toEqual(
      new Set([fulfillmentWrite.featureUnlockId]),
    );
    expect(
      await database
        .selectFrom('interaction.feature_unlocks')
        .select(['payer_user_id', 'feature_type', 'match_id', 'payment_record_id'])
        .where('payment_record_id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      payer_user_id: payer.userId,
      feature_type: 'chat_unlock',
      match_id: matchId,
      payment_record_id: payment.paymentRecordId,
    });
    expect(
      await database
        .selectFrom('billing.credit_accounts')
        .select('balance')
        .where('user_id', 'in', [payer.userId, other.userId])
        .execute(),
    ).toEqual([{ balance: '0' }, { balance: '0' }]);
    const notifications = await database
      .selectFrom('notification.notifications')
      .select(['user_id', 'notification_type'])
      .where('user_id', 'in', [payer.userId, other.userId])
      .where('notification_type', 'in', ['payment_success', 'chat_unlocked', 'safety_notice'])
      .execute();
    expect(notifications).toHaveLength(5);
    expect(
      notifications.filter(({ notification_type }) => notification_type === 'payment_success'),
    ).toEqual([{ user_id: payer.userId, notification_type: 'payment_success' }]);
  });

  it('ACC-037 creates one correction when a paid Match closes before fulfillment', async () => {
    const payer = await createUser(database);
    const other = await createUser(database);
    const matchId = await createActiveMatch(payer.userId, other.userId);
    const payment = await preparePaymentFor(payer, { type: 'match', targetId: matchId });
    const telegramChargeId = `telegram:${randomUUID()}`;
    const eventId = `closed-target:${randomUUID()}`;
    await receipts.recordSuccessfulPayment({
      providerEventId: eventId,
      telegramUserId: payer.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      telegramChargeId,
      evidence: evidence(eventId),
    });
    await database
      .updateTable('matching.matches')
      .set((expression) => ({
        status: 'closed',
        closed_at: new Date(),
        version: expression('version', '+', 1),
      }))
      .where('id', '=', matchId)
      .executeTakeFirstOrThrow();
    const claim = (
      await receipts.claimFulfillments({ owner: 'correction-worker', leaseMs: 60_000, limit: 100 })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId);
    expect(claim).toBeDefined();
    const write = {
      paymentRecordId: payment.paymentRecordId,
      owner: 'correction-worker',
      fenceToken: claim!.fenceToken,
      featureUnlockId: randomUUID(),
      refundRecordId: randomUUID(),
      featureUnlockedEventId: randomUUID(),
      paymentTerminalEventId: randomUUID(),
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => receipts.fulfillDirectPaidAction(write)),
    );
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(19);
    expect(new Set(results.map(({ refundRecordId }) => refundRecordId))).toEqual(
      new Set([write.refundRecordId]),
    );
    expect(
      await database
        .selectFrom('billing.refund_records')
        .select(['user_id', 'payment_record_id', 'telegram_charge_id', 'stars_amount', 'status'])
        .where('payment_record_id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      user_id: payer.userId,
      payment_record_id: payment.paymentRecordId,
      telegram_charge_id: telegramChargeId,
      stars_amount: payment.starsAmount.toString(),
      status: 'pending',
    });
    expect(
      await database
        .selectFrom('interaction.feature_unlocks')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('payment_record_id', '=', payment.paymentRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '0' });

    const refundClaim = (
      await refunds.claimStarsRefunds({ owner: 'refund-worker', leaseMs: 60_000, limit: 100 })
    ).find(({ refundRecordId }) => refundRecordId === write.refundRecordId);
    expect(refundClaim).toBeDefined();
    await expect(refunds.beginProviderCall(refundClaim!)).resolves.toBe(true);
    const completions = await Promise.all(
      Array.from({ length: 20 }, () => refunds.completeStarsRefund(refundClaim!)),
    );
    expect(completions.filter((outcome) => outcome === 'processed')).toHaveLength(1);
    expect(completions.filter((outcome) => outcome === 'replayed')).toHaveLength(19);
    const processedRefund = await database
      .selectFrom('billing.refund_records')
      .select(['status', 'provider_progress', 'attempt_count', 'processed_at'])
      .where('id', '=', write.refundRecordId)
      .executeTakeFirstOrThrow();
    expect(processedRefund.status).toBe('processed');
    expect(processedRefund.provider_progress).toBe('refund_confirmed');
    expect(processedRefund.attempt_count).toBe(1);
    expect(processedRefund.processed_at).toBeInstanceOf(Date);
    const refundedPayment = await database
      .selectFrom('billing.payment_records')
      .select(['status', 'refunded_at'])
      .where('id', '=', payment.paymentRecordId)
      .executeTakeFirstOrThrow();
    expect(refundedPayment.status).toBe('refunded');
    expect(refundedPayment.refunded_at).toBeInstanceOf(Date);
    const correctedFulfillment = await database
      .selectFrom('billing.payment_fulfillments')
      .select(['state', 'corrected_at'])
      .where('payment_record_id', '=', payment.paymentRecordId)
      .executeTakeFirstOrThrow();
    expect(correctedFulfillment.state).toBe('corrected');
    expect(correctedFulfillment.corrected_at).toBeInstanceOf(Date);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select(['notification_type', 'title_key'])
        .where(
          'deduplication_key',
          '=',
          `payment:${payment.paymentRecordId}:${payer.userId}:corrected`,
        )
        .executeTakeFirstOrThrow(),
    ).toEqual({
      notification_type: 'payment_failure',
      title_key: 'notification.payment_corrected.title',
    });
    expect(
      (
        await refunds.claimStarsRefunds({
          owner: 'second-refund-worker',
          leaseMs: 60_000,
          limit: 100,
        })
      ).find(({ refundRecordId }) => refundRecordId === write.refundRecordId),
    ).toBeUndefined();
  });

  it('quarantines an ambiguous provider outcome from normal refund retry', async () => {
    const payer = await createUser(database);
    const other = await createUser(database);
    const matchId = await createActiveMatch(payer.userId, other.userId);
    const payment = await preparePaymentFor(payer, { type: 'match', targetId: matchId });
    const eventId = `ambiguous-refund:${randomUUID()}`;
    await receipts.recordSuccessfulPayment({
      providerEventId: eventId,
      telegramUserId: payer.telegramUserId,
      invoicePayload: payment.payload.cleartext,
      currency: 'XTR',
      totalAmount: payment.starsAmount,
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      telegramChargeId: `telegram:${randomUUID()}`,
      evidence: evidence(eventId),
    });
    await database
      .updateTable('matching.matches')
      .set((expression) => ({
        status: 'closed',
        closed_at: new Date(),
        version: expression('version', '+', 1),
      }))
      .where('id', '=', matchId)
      .executeTakeFirstOrThrow();
    const fulfillmentClaim = (
      await receipts.claimFulfillments({
        owner: 'ambiguous-fulfillment-worker',
        leaseMs: 60_000,
        limit: 100,
      })
    ).find(({ paymentRecordId }) => paymentRecordId === payment.paymentRecordId);
    expect(fulfillmentClaim).toBeDefined();
    const refundRecordId = randomUUID();
    await receipts.fulfillDirectPaidAction({
      paymentRecordId: payment.paymentRecordId,
      owner: 'ambiguous-fulfillment-worker',
      fenceToken: fulfillmentClaim!.fenceToken,
      featureUnlockId: randomUUID(),
      refundRecordId,
      featureUnlockedEventId: randomUUID(),
      paymentTerminalEventId: randomUUID(),
    });
    const claim = (
      await refunds.claimStarsRefunds({
        owner: 'ambiguous-refund-worker',
        leaseMs: 60_000,
        limit: 100,
      })
    ).find((candidate) => candidate.refundRecordId === refundRecordId);
    expect(claim).toBeDefined();
    await expect(refunds.beginProviderCall(claim!)).resolves.toBe(true);
    await expect(
      refunds.recordProviderFailure({
        ...claim!,
        kind: 'ambiguous',
        errorCode: 'provider_outcome_unknown',
      }),
    ).resolves.toBe(true);
    expect(
      await database
        .selectFrom('billing.refund_records')
        .select(['status', 'provider_progress', 'lease_owner', 'last_error_code'])
        .where('id', '=', refundRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: 'failed_retryable',
      provider_progress: 'call_started',
      lease_owner: null,
      last_error_code: 'provider_outcome_unknown',
    });
    const reclaim = await refunds.claimStarsRefunds({
      owner: 'must-not-call-provider-again',
      leaseMs: 60_000,
      limit: 100,
    });
    expect(
      reclaim.find((candidate) => candidate.refundRecordId === refundRecordId),
    ).toBeUndefined();

    const proposedRunId = randomUUID();
    const runId = await reconciliation.resumeOrStart(proposedRunId);
    const refundBatch = await reconciliation.scanNextBatch(runId, 100);
    expect(refundBatch.completed).toBe(false);
    expect(refundBatch.anomalyCount).toBeGreaterThanOrEqual(1);
    const paymentBatch = await reconciliation.scanNextBatch(runId, 100);
    expect(paymentBatch.completed).toBe(true);
    expect(
      await database
        .selectFrom('billing.reconciliation_anomalies')
        .select([
          'run_id',
          'anomaly_type',
          'entity_type',
          'entity_id',
          'disposition',
          'safe_detail',
        ])
        .where('entity_type', '=', 'refund_record')
        .where('entity_id', '=', refundRecordId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      run_id: runId,
      anomaly_type: 'stars_refund_outcome_uncertain',
      entity_type: 'refund_record',
      entity_id: refundRecordId,
      disposition: 'quarantined',
      safe_detail: {
        status: 'failed_retryable',
        providerProgress: 'call_started',
        errorCode: 'provider_outcome_unknown',
      },
    });
    const completedRun = await database
      .selectFrom('billing.reconciliation_runs')
      .select(['status', 'finished_at'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(completedRun.status).toBe('succeeded');
    expect(completedRun.finished_at).toBeInstanceOf(Date);

    const operator = await createUser(database);
    const adminId = randomUUID();
    await database
      .insertInto('administration.admin_users')
      .values({
        id: adminId,
        user_id: operator.userId,
        telegram_user_id: operator.telegramUserId,
        is_active: true,
        disabled_at: null,
        identity_verified_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const notRefundedResolution = {
      actor: { kind: 'admin' as const, userId: operator.userId },
      refundRecordId,
      observedOutcome: 'not_refunded' as const,
      evidenceDigest: digest(`not-refunded:${refundRecordId}`),
      requestId: randomUUID(),
      commandId: randomUUID(),
      auditId: randomUUID(),
      eventId: randomUUID(),
    };
    await expect(refunds.resolveAmbiguousStarsRefund(notRefundedResolution)).resolves.toEqual({
      outcome: 'retry_scheduled',
      replayed: false,
    });
    await expect(refunds.resolveAmbiguousStarsRefund(notRefundedResolution)).resolves.toEqual({
      outcome: 'retry_scheduled',
      replayed: true,
    });
    const retryClaim = (
      await refunds.claimStarsRefunds({
        owner: 'verified-retry-worker',
        leaseMs: 60_000,
        limit: 100,
      })
    ).find((candidate) => candidate.refundRecordId === refundRecordId);
    expect(retryClaim).toBeDefined();
    await expect(refunds.beginProviderCall(retryClaim!)).resolves.toBe(true);
    await expect(
      refunds.recordProviderFailure({
        ...retryClaim!,
        kind: 'ambiguous',
        errorCode: 'provider_outcome_unknown',
      }),
    ).resolves.toBe(true);
    const refundedResolution = {
      actor: { kind: 'admin' as const, userId: operator.userId },
      refundRecordId,
      observedOutcome: 'refunded' as const,
      evidenceDigest: digest(`refunded:${refundRecordId}`),
      requestId: randomUUID(),
      commandId: randomUUID(),
      auditId: randomUUID(),
      eventId: randomUUID(),
    };
    await expect(refunds.resolveAmbiguousStarsRefund(refundedResolution)).resolves.toEqual({
      outcome: 'corrected',
      replayed: false,
    });
    const finalRefund = await database
      .selectFrom('billing.refund_records')
      .select(['status', 'provider_progress'])
      .where('id', '=', refundRecordId)
      .executeTakeFirstOrThrow();
    expect(finalRefund).toEqual({ status: 'processed', provider_progress: 'refund_confirmed' });
    const finalPayment = await database
      .selectFrom('billing.payment_records')
      .select('status')
      .where('id', '=', payment.paymentRecordId)
      .executeTakeFirstOrThrow();
    expect(finalPayment.status).toBe('refunded');
    const audit = await database
      .selectFrom('platform.audit_logs')
      .select(['actor_admin_id', 'result_code'])
      .where('subject_type', '=', 'refund_record')
      .where('subject_id', '=', refundRecordId)
      .where('event_type', '=', 'billing.ambiguous-refund-resolved.v1')
      .orderBy('occurred_at', 'asc')
      .execute();
    expect(audit).toEqual([
      { actor_admin_id: adminId, result_code: 'not_refunded' },
      { actor_admin_id: adminId, result_code: 'refunded' },
    ]);
  });
});
