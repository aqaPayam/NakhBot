import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProtectedInvoicePayload } from '@nakh/application';

import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresFundingStore } from './funding-store.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

async function createUser(database: NakhDatabase): Promise<string> {
  const userId = randomUUID();
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
    .insertInto('billing.credit_accounts')
    .values({ user_id: userId, created_at: now, updated_at: now })
    .execute();
  return userId;
}

function payload(index: number): ProtectedInvoicePayload {
  const cleartext = `opaque-${randomUUID()}-${index}`;
  return {
    cleartext,
    digest: createHash('sha256').update(cleartext).digest('hex'),
    ciphertext: Uint8Array.from({ length: 32 }, (_, offset) => (offset + index) % 256),
    keyId: 'billing-v1',
  };
}

describe.skipIf(databaseUrl === undefined)('M4 PostgreSQL funding intents', () => {
  let database: NakhDatabase;
  let store: PostgresFundingStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 8,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 2_000,
    });
    store = new PostgresFundingStore(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('snapshots an active package price without accepting a client amount', async () => {
    const userId = await createUser(database);
    const idempotencyKey = `package-intent:${randomUUID()}`;
    const first = await store.createFundingIntent({
      intentId: randomUUID(),
      userId,
      funding: 'stars',
      target: { type: 'credit_package', packageCode: 'best_value' },
      idempotencyKey,
    });
    const replay = await store.createFundingIntent({
      intentId: randomUUID(),
      userId,
      funding: 'stars',
      target: { type: 'credit_package', packageCode: 'best_value' },
      idempotencyKey,
    });
    expect(first).toMatchObject({ funding: 'stars', requiredAmount: 35n, replayed: false });
    expect(replay).toMatchObject({ id: first.id, requiredAmount: 35n, replayed: true });
    const row = await database
      .selectFrom('billing.pending_payments')
      .selectAll()
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      reason: 'buy_credit_package',
      funding_type: 'telegram_stars',
      required_stars: '35',
      package_code_snapshot: 'best_value',
      package_credit_amount_snapshot: '50',
      status: 'pending',
    });
    await expect(
      store.createFundingIntent({
        intentId: randomUUID(),
        userId,
        funding: 'credits',
        target: { type: 'credit_package', packageCode: 'best_value' },
        idempotencyKey: `forged-credit-package:${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('admits exactly ten serialized provider attempts in ten minutes', async () => {
    const userId = await createUser(database);
    const intent = await store.createFundingIntent({
      intentId: randomUUID(),
      userId,
      funding: 'stars',
      target: { type: 'credit_package', packageCode: 'starter' },
      idempotencyKey: `attempt-intent:${randomUUID()}`,
    });
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.prepareStarsAttempt({
          paymentRecordId: randomUUID(),
          fundingIntentId: intent.id,
          expectedVersion: 1,
          userId,
          idempotencyKey: `provider-attempt:${randomUUID()}`,
          providerEnvironment: 'test',
          providerBotIdDigest: 'b'.repeat(64),
          payload: payload(index),
        }),
      ),
    );
    expect(attempts).toHaveLength(10);
    expect(new Set(attempts.map(({ paymentRecordId }) => paymentRecordId))).toHaveProperty(
      'size',
      10,
    );
    await expect(
      store.prepareStarsAttempt({
        paymentRecordId: randomUUID(),
        fundingIntentId: intent.id,
        expectedVersion: 1,
        userId,
        idempotencyKey: `provider-attempt:${randomUUID()}`,
        providerEnvironment: 'test',
        providerBotIdDigest: 'b'.repeat(64),
        payload: payload(11),
      }),
    ).rejects.toMatchObject({ code: 'payment_attempt_limit' });
    expect(
      await database
        .selectFrom('billing.payment_records')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '10' });
  });

  it('replays one attempt without consuming another rate-limit slot or payload', async () => {
    const userId = await createUser(database);
    const intent = await store.createFundingIntent({
      intentId: randomUUID(),
      userId,
      funding: 'stars',
      target: { type: 'credit_package', packageCode: 'plus' },
      idempotencyKey: `replay-intent:${randomUUID()}`,
    });
    const idempotencyKey = `replayed-attempt:${randomUUID()}`;
    const firstPayload = payload(21);
    const write = {
      paymentRecordId: randomUUID(),
      fundingIntentId: intent.id,
      expectedVersion: 1,
      userId,
      idempotencyKey,
      providerEnvironment: 'test' as const,
      providerBotIdDigest: 'c'.repeat(64),
      payload: firstPayload,
    };
    const first = await store.prepareStarsAttempt(write);
    const replay = await store.prepareStarsAttempt({
      ...write,
      paymentRecordId: randomUUID(),
      payload: payload(22),
    });
    expect(first).toMatchObject({ starsAmount: 20n, replayed: false });
    expect(replay).toMatchObject({ paymentRecordId: first.paymentRecordId, replayed: true });
    expect(replay.payloadCiphertext).toEqual(firstPayload.ciphertext);
  });
});
