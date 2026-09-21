import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  EncryptedProviderEvidence,
  ProtectedInvoicePayload,
  TelegramSuccessfulPaymentWrite,
} from '@nakh/application';

import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresFundingStore } from './funding-store.js';
import { runMigrations } from './migrations.js';
import { PostgresTelegramStarsReceiptStore } from './payment-receipt-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const botDigest = 'b'.repeat(64);
const ids = { uuid: randomUUID };

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
    .insertInto('billing.credit_accounts')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  return { userId, telegramUserId };
}

describe.skipIf(databaseUrl === undefined)('M4 durable Telegram Stars receipts', () => {
  let database: NakhDatabase;
  let funding: PostgresFundingStore;
  let receipts: PostgresTelegramStarsReceiptStore;

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
    const fulfillmentWrite = {
      paymentRecordId: payment.paymentRecordId,
      owner: 'package-worker',
      fenceToken: claimed!.fenceToken,
      creditTransactionId: randomUUID(),
      creditIncreasedEventId: randomUUID(),
      paymentFulfilledEventId: randomUUID(),
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
    const fulfillmentWrite = {
      paymentRecordId: payment.paymentRecordId,
      owner: 'direct-worker',
      fenceToken: claim!.fenceToken,
      featureUnlockId: randomUUID(),
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
  });
});
