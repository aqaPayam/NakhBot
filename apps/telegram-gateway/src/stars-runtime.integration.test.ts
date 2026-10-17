import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  runMigrations,
  PostgresFundingStore,
  PostgresUserSessionStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type {
  UserSessionActor,
  CreateFundingIntentWrite,
  StoredFundingIntent,
  ProtectedInvoicePayload,
  PrepareStarsAttemptWrite,
  StoredStarsAttempt,
} from '@nakh/application';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { TelegramStarsKeys } from './stars-keys.js';
import { TelegramStarsClient, TelegramStarsRuntime } from './stars-runtime.js';
import { createHash } from 'node:crypto';

const url = process.env.NAKH_TEST_DATABASE_URL;
const old = {
  id: 'v1',
  invoiceKey: Buffer.alloc(32, 1).toString('base64url'),
  evidenceKey: Buffer.alloc(32, 2).toString('base64url'),
};
const next = {
  id: 'v2',
  invoiceKey: Buffer.alloc(32, 3).toString('base64url'),
  evidenceKey: Buffer.alloc(32, 4).toString('base64url'),
};
const ring = (
  activeKeyId = 'v1',
  keys = [old],
  digestKey = Buffer.alloc(32, 5).toString('base64url'),
): string => JSON.stringify({ activeKeyId, keys, digestKey });
const botDigest = createHash('sha256').update('12345').digest('hex');
describe.skipIf(url === undefined)('composed Stars ingress with native financial custody', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, db: NakhDatabase;
  const keys = new TelegramStarsKeys(ring());
  let serial = 900000;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_stars');
    await runMigrations(isolated.url, resolve('migrations'));
    db = createDatabase({
      url: isolated.url,
      poolMax: 12,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
    });
  }, 120000);
  afterAll(async () => {
    await db?.destroy();
    await isolated?.destroy();
  });
  async function fixture(): Promise<{
    actor: UserSessionActor;
    funding: PostgresFundingStore;
    write: CreateFundingIntentWrite;
    intent: StoredFundingIntent;
    payload: ProtectedInvoicePayload;
    attemptWrite: PrepareStarsAttemptWrite;
    attempt: StoredStarsAttempt;
    telegramUserId: string;
  }> {
    const userId = randomUUID(),
      telegramUserId = String(serial++),
      now = new Date();
    await db
      .insertInto('identity.users')
      .values({ id: userId, last_activity_at: now, created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('identity.accounts')
      .values({ user_id: userId, state: 'active', state_reason: null, state_changed_at: now })
      .execute();
    await db
      .insertInto('identity.telegram_identities')
      .values({
        user_id: userId,
        telegram_user_id: telegramUserId,
        username: null,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
    await db
      .insertInto('identity.user_settings')
      .values({ user_id: userId, created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('billing.credit_accounts')
      .values({ user_id: userId, created_at: now, updated_at: now })
      .execute();
    const grant = await new PostgresUserSessionStore(db).issue(
      { userId, productEpoch: 0 },
      randomUUID(),
    );
    if (!grant) throw new Error('Missing native session');
    const actor: UserSessionActor = {
      kind: 'user',
      userId,
      productEpoch: 0,
      sessionGrantId: grant.id,
    };
    const funding = new PostgresFundingStore(db, actor);
    const write = {
      intentId: randomUUID(),
      userId,
      funding: 'stars' as const,
      target: { type: 'credit_package' as const, packageCode: 'starter' as const },
      idempotencyKey: randomUUID(),
    };
    const intent = await funding.createFundingIntent(write),
      payload = keys.issue();
    const attemptWrite = {
      paymentRecordId: randomUUID(),
      userId,
      fundingIntentId: intent.id,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      providerEnvironment: 'test' as const,
      providerBotIdDigest: botDigest,
      payload,
    };
    const attempt = await funding.prepareStarsAttempt(attemptWrite);
    return { actor, funding, write, intent, payload, attemptWrite, attempt, telegramUserId };
  }
  function update(
    f: Awaited<ReturnType<typeof fixture>>,
    paid: boolean,
    id = serial++,
  ): {
    update_id: number;
    pre_checkout_query?: {
      currency: string;
      total_amount: number;
      invoice_payload: string;
      id: string;
      from: { id: number; is_bot: boolean; first_name: string };
    };
    message?: {
      from: { id: number; is_bot: boolean };
      successful_payment: {
        currency: string;
        total_amount: number;
        invoice_payload: string;
        telegram_payment_charge_id: string;
        provider_payment_charge_id: string;
        private_address: string;
      };
    };
  } {
    const facts = {
      currency: 'XTR',
      total_amount: Number(f.intent.requiredAmount),
      invoice_payload: f.payload.cleartext,
    };
    return paid
      ? {
          update_id: id,
          message: {
            from: { id: Number(f.telegramUserId), is_bot: false },
            successful_payment: {
              ...facts,
              telegram_payment_charge_id: `charge-${id}`,
              provider_payment_charge_id: '',
              private_address: 'never-retain-this',
            },
          },
        }
      : {
          update_id: id,
          pre_checkout_query: {
            ...facts,
            id: `query-${id}`,
            from: { id: Number(f.telegramUserId), is_bot: false, first_name: 'never-retain-this' },
          },
        };
  }
  it('commits the pre-checkout decision before answering and retries an uncertain answer', async () => {
    const f = await fixture(),
      event = update(f, false),
      fetcher = vi.fn<typeof fetch>();
    fetcher.mockImplementation(async () => {
      const row = await db
        .selectFrom('billing.payment_provider_events')
        .select('id')
        .where('provider_event_id', '=', String(event.update_id))
        .executeTakeFirst();
      expect(row).toBeDefined();
      if (fetcher.mock.calls.length === 1) throw new Error('lost provider acknowledgement');
      return Response.json({ ok: true, result: true });
    });
    const runtime = new TelegramStarsRuntime(
      db,
      keys,
      'test',
      '12345',
      new TelegramStarsClient(`12345:${'a'.repeat(24)}`, fetcher),
    );
    await runtime.onModuleInit();
    await expect(runtime.handle(event)).rejects.toMatchObject({ status: 502 });
    expect(await runtime.handle(event)).toBe('notice');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const events = await db
      .selectFrom('billing.payment_provider_events')
      .selectAll()
      .where('provider_event_id', '=', String(event.update_id))
      .execute();
    expect(events).toHaveLength(1);
    expect(
      JSON.stringify(
        keys.openEvidence(events[0]!.raw_payload_ciphertext, events[0]!.raw_payload_key_id),
      ),
    ).not.toContain('never-retain-this');
  });
  it('records concurrent paid retries once after session revocation without calling Telegram', async () => {
    const f = await fixture(),
      event = update(f, true),
      fetcher = vi.fn<typeof fetch>();
    await new PostgresUserSessionStore(db).revoke(f.actor, f.actor.sessionGrantId, randomUUID());
    const runtime = new TelegramStarsRuntime(
      db,
      keys,
      'test',
      '12345',
      new TelegramStarsClient(`12345:${'a'.repeat(24)}`, fetcher),
    );
    expect(await Promise.all(Array.from({ length: 8 }, () => runtime.handle(event)))).toEqual(
      Array(8).fill('notice'),
    );
    const payment = await db
      .selectFrom('billing.payment_records')
      .selectAll()
      .where('id', '=', f.attempt.paymentRecordId)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('paid');
    expect(
      await db
        .selectFrom('billing.payment_provider_events')
        .select('id')
        .where('provider_event_id', '=', String(event.update_id))
        .execute(),
    ).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(f.funding.prepareStarsAttempt(f.attemptWrite)).rejects.toMatchObject({
      status: 401,
    });
    await expect(f.funding.createFundingIntent(f.write)).rejects.toMatchObject({ status: 401 });
  });
  it('uses native custody to reject lost historical keys, overwritten encryption and changed digest secrets', async () => {
    await fixture();
    await expect(
      new TelegramStarsKeys(ring('v2', [old, next])).verifyCustody(db),
    ).resolves.toBeUndefined();
    for (const value of [
      ring('v2', [next]),
      ring('v1', [{ ...old, invoiceKey: next.invoiceKey }]),
      ring('v1', [old], Buffer.alloc(32, 9).toString('base64url')),
    ])
      await expect(new TelegramStarsKeys(value).verifyCustody(db)).rejects.toThrow();
  });
  it.each(['payer', 'currency', 'amount'] as const)(
    'durably declines mismatched %s without marking a payment paid',
    async (kind) => {
      const f = await fixture(),
        event = update(f, false);
      const query = event.pre_checkout_query!;
      if (kind === 'payer') query.from.id = Number((await fixture()).telegramUserId);
      if (kind === 'currency') query.currency = 'USD';
      if (kind === 'amount') query.total_amount++;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ok: true, result: true }));
      const runtime = new TelegramStarsRuntime(
        db,
        keys,
        'test',
        '12345',
        new TelegramStarsClient(`12345:${'a'.repeat(24)}`, fetcher),
      );
      expect(await runtime.handle(event)).toBe('notice');
      const body = fetcher.mock.calls[0]![1]?.body;
      expect(JSON.parse(typeof body === 'string' ? body : '')).toMatchObject({ ok: false });
      expect(
        (
          await db
            .selectFrom('billing.payment_records')
            .select('status')
            .where('id', '=', f.attempt.paymentRecordId)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('pending');
      expect(
        await db
          .selectFrom('billing.payment_provider_events')
          .select('id')
          .where('provider_event_id', '=', String(event.update_id))
          .execute(),
      ).toHaveLength(1);
    },
  );
  it('rejects borrowed funding authority before native cached intent or attempt results', async () => {
    const a = await fixture(),
      b = await fixture(),
      borrowed = new PostgresFundingStore(db, b.actor);
    await expect(borrowed.createFundingIntent(a.write)).rejects.toMatchObject({ status: 401 });
    await expect(borrowed.prepareStarsAttempt(a.attemptWrite)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('captures actor and nested writes before asynchronous work and serializes invoice retries', async () => {
    const f = await fixture(),
      actor = { ...f.actor },
      store = new PostgresFundingStore(db, actor);
    actor.sessionGrantId = randomUUID();
    const write = { ...structuredClone(f.attemptWrite) },
      originalId = write.idempotencyKey;
    write.idempotencyKey = randomUUID();
    write.paymentRecordId = randomUUID();
    write.payload = keys.issue();
    const original = structuredClone(write),
      first = store.prepareStarsAttempt(write);
    write.userId = randomUUID();
    write.payload = { ...write.payload, keyId: 'forged' };
    const results = await Promise.all([
      first,
      ...Array.from({ length: 7 }, () => store.prepareStarsAttempt(original)),
    ]);
    expect(new Set(results.map((r) => r.paymentRecordId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(originalId).not.toBe(original.idempotencyKey);
    expect(
      await db
        .selectFrom('billing.payment_records')
        .select('id')
        .where('user_id', '=', f.actor.userId)
        .execute(),
    ).toHaveLength(2);
  });
});
