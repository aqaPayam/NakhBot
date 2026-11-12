import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  runMigrations,
  PostgresFundingStore,
  PostgresUserSessionStore,
  PostgresStarsPurchaseConsentStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type {
  UserSessionActor,
  CreateFundingIntentWrite,
  StoredFundingIntent,
  ProtectedInvoicePayload,
  PrepareStarsAttemptWrite,
  StoredStarsAttempt,
  StarsPurchaseOffer,
  StarsPurchaseConsentWrite,
} from '@nakh/application';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { TelegramStarsKeys } from './stars-keys.js';
import { TelegramStarsClient, TelegramStarsRuntime } from './stars-runtime.js';
import { createHash } from 'node:crypto';
import { CREDIT_PACKAGE_DEFINITIONS, type CreditPackageCode } from '@nakh/domain';

function invoiceBody(body: RequestInit['body']): {
  title: string;
  description: string;
  payload: string;
  prices: { label: string; amount: number }[];
} {
  if (typeof body !== 'string') throw new Error('Expected a JSON invoice request');
  return JSON.parse(body) as ReturnType<typeof invoiceBody>;
}

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
  async function fixture(packageCode: CreditPackageCode = 'starter'): Promise<{
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
      target: { type: 'credit_package' as const, packageCode },
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
  async function consent(f: Awaited<ReturnType<typeof fixture>>): Promise<{
    store: PostgresStarsPurchaseConsentStore;
    offer: StarsPurchaseOffer;
    write: StarsPurchaseConsentWrite;
  }> {
    const store = new PostgresStarsPurchaseConsentStore(db, f.actor);
    const offer = await store.review(f.intent.id, 1);
    const write = {
      fundingIntentId: f.intent.id,
      expectedVersion: 1,
      offerDigest: offer.digest,
      termsVersion: 'test_terms_v1',
      documentDigest: 'd'.repeat(64),
      locale: 'en',
      commandId: randomUUID(),
      requestId: randomUUID(),
    };
    return { store, offer, write };
  }
  it('records exactly one immutable consent for concurrent confirmations and later retries', async () => {
    const f = await fixture('plus'),
      c = await consent(f);
    const results = await Promise.all(Array.from({ length: 12 }, () => c.store.accept(c.write)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const replay = await c.store.accept({
      ...c.write,
      commandId: randomUUID(),
      requestId: randomUUID(),
    });
    expect(replay.id).toBe(results[0]!.id);
    expect(replay.replayed).toBe(true);
    expect(replay.offer).toMatchObject({ stars: '20', credits: '25', packageCode: 'plus' });
    const audits = await db
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('subject_id', '=', f.intent.id)
      .where('event_type', '=', 'billing.stars-purchase-consent.v1')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      request_id: c.write.requestId,
      command_id: c.write.commandId,
      actor_user_id: f.actor.userId,
      result_code: 'accepted',
      metadata: {
        productEpoch: 0,
        sessionGrantId: f.actor.sessionGrantId,
        offerDigest: c.offer.digest,
        termsVersion: c.write.termsVersion,
        documentDigest: c.write.documentDigest,
        locale: 'en',
      },
    });
    await expect(
      db
        .updateTable('platform.audit_logs')
        .set({ result_code: 'changed' })
        .where('id', '=', replay.id)
        .execute(),
    ).rejects.toThrow();
  });
  it('requires native consent before protected invoice transport and reuses the accepted snapshot', async () => {
    const f = await fixture('ultimate'),
      c = await consent(f),
      { client, fetcher } = invoiceClient(f);
    const runtime = new TelegramStarsRuntime(db, keys, 'test', '12345', client, true, true);
    await expect(runtime.invoice(invoiceRequest(f))).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
    const accepted = await c.store.accept(c.write);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        runtime.invoice({ ...invoiceRequest(f), purchaseConsentId: accepted.id }),
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(invoiceBody(fetcher.mock.calls[0]![1]?.body).prices).toEqual([
      { label: 'Buy credits', amount: 60 },
    ]);
    expect((await c.store.require(accepted.id, f.intent.id, 1)).documentDigest).toBe(
      c.write.documentDigest,
    );
  });
  it('cannot apply another owner or another offer consent', async () => {
    const f = await fixture(),
      other = await fixture(),
      c = await consent(f),
      accepted = await c.store.accept(c.write);
    const foreign = new PostgresStarsPurchaseConsentStore(db, other.actor);
    await expect(foreign.require(accepted.id, f.intent.id, 1)).rejects.toMatchObject({
      status: 403,
    });
    await expect(foreign.accept(c.write)).rejects.toMatchObject({ status: 403 });
    await expect(c.store.require(accepted.id, other.intent.id, 1)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('does not transfer an original consent to a new sign-in grant', async () => {
    const f = await fixture(),
      c = await consent(f),
      accepted = await c.store.accept(c.write);
    const grant = await new PostgresUserSessionStore(db).issue(f.actor, randomUUID());
    expect(grant).toBeDefined();
    expect(grant!.id).not.toBe(f.actor.sessionGrantId);
    await expect(
      new PostgresStarsPurchaseConsentStore(db, { ...f.actor, sessionGrantId: grant!.id }).require(
        accepted.id,
        f.intent.id,
        1,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('fences revoked sessions before accepting or replaying consent and sending invoices', async () => {
    const f = await fixture(),
      c = await consent(f),
      accepted = await c.store.accept(c.write),
      { client, fetcher } = invoiceClient(f);
    await new PostgresUserSessionStore(db).revoke(f.actor, f.actor.sessionGrantId, randomUUID());
    await expect(c.store.accept(c.write)).rejects.toMatchObject({ status: 401 });
    await expect(c.store.require(accepted.id, f.intent.id, 1)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      new TelegramStarsRuntime(db, keys, 'test', '12345', client, true, true).invoice({
        ...invoiceRequest(f),
        purchaseConsentId: accepted.id,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a consent presented for another product life without bypassing the native return guard', async () => {
    const f = await fixture(),
      c = await consent(f),
      accepted = await c.store.accept(c.write);
    await expect(
      db
        .updateTable('identity.accounts')
        .set({ product_epoch: 1 })
        .where('user_id', '=', f.actor.userId)
        .execute(),
    ).rejects.toThrow('account lifecycle is immutable outside verified return');
    const otherLife = new PostgresStarsPurchaseConsentStore(db, { ...f.actor, productEpoch: 1 });
    await expect(otherLife.require(accepted.id, f.intent.id, 1)).rejects.toMatchObject({
      status: 401,
    });
    await expect(otherLife.accept(c.write)).rejects.toMatchObject({ status: 401 });
    expect((await c.store.require(accepted.id, f.intent.id, 1)).id).toBe(accepted.id);
  });
  it.each(['restricted', 'banned'] as const)(
    'does not accept or replay purchase consent for a %s account',
    async (state) => {
      const f = await fixture(),
        c = await consent(f),
        accepted = await c.store.accept(c.write);
      await db
        .updateTable('identity.accounts')
        .set({ state, state_reason: 'test', state_changed_at: new Date() })
        .where('user_id', '=', f.actor.userId)
        .execute();
      await expect(c.store.require(accepted.id, f.intent.id, 1)).rejects.toMatchObject({
        status: 403,
      });
      await expect(c.store.accept(c.write)).rejects.toMatchObject({ status: 403 });
    },
  );
  it('requires the reviewed native offer digest and expected version', async () => {
    const f = await fixture(),
      c = await consent(f);
    await expect(c.store.accept({ ...c.write, offerDigest: 'a'.repeat(64) })).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(c.store.accept({ ...c.write, expectedVersion: 2 })).rejects.toMatchObject({
      status: 403,
    });
    expect(
      await db
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', f.intent.id)
        .where('event_type', '=', 'billing.stars-purchase-consent.v1')
        .execute(),
    ).toHaveLength(0);
  });
  it('bounds new consents without charging the limit for identical retries', async () => {
    const f = await fixture(),
      c = await consent(f);
    for (let i = 0; i < 10; i++) await c.store.accept({ ...c.write, termsVersion: `test_v${i}` });
    await expect(c.store.accept({ ...c.write, termsVersion: 'test_v10' })).rejects.toMatchObject({
      status: 429,
    });
    expect((await c.store.accept({ ...c.write, termsVersion: 'test_v0' })).replayed).toBe(true);
  });
  it('keeps paid receipts independent of purchase consent or a live customer session', async () => {
    const f = await fixture(),
      c = await consent(f),
      accepted = await c.store.accept(c.write),
      { client, fetcher } = invoiceClient(f);
    await new PostgresUserSessionStore(db).revoke(f.actor, f.actor.sessionGrantId, randomUUID());
    const runtime = new TelegramStarsRuntime(db, keys, 'test', '12345', client, false, true);
    expect(await runtime.handle(update(f, true))).toBe('notice');
    const payment = await db
      .selectFrom('billing.payment_records')
      .select('status')
      .where('id', '=', f.attempt.paymentRecordId)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe('paid');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(c.store.require(accepted.id, f.intent.id, 1)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('rejects expired native offers using database time without creating consent', async () => {
    const f = await fixture(),
      c = await consent(f);
    const original = await db
      .selectFrom('billing.pending_payments')
      .selectAll()
      .where('id', '=', f.intent.id)
      .executeTakeFirstOrThrow();
    const plus = await db
      .selectFrom('billing.credit_packages')
      .select('id')
      .where('code', '=', 'plus')
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    await db
      .insertInto('billing.pending_payments')
      .values({
        ...original,
        id,
        target_id: plus.id,
        package_code_snapshot: 'plus',
        package_credit_amount_snapshot: '25',
        required_stars: '20',
        idempotency_key: randomUUID(),
        created_at: new Date('2000-01-01T00:00:00Z'),
        expires_at: new Date('2000-01-01T00:10:00Z'),
      })
      .execute();
    await expect(c.store.review(id, 1)).rejects.toMatchObject({ status: 403 });
    await expect(c.store.accept({ ...c.write, fundingIntentId: id })).rejects.toMatchObject({
      status: 403,
    });
    expect(
      await db
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', id)
        .execute(),
    ).toHaveLength(0);
  });
  it('rejects cancelled offers and already captured payments on consent replay', async () => {
    const f = await fixture(),
      c = await consent(f),
      accepted = await c.store.accept(c.write);
    await db
      .updateTable('billing.pending_payments')
      .set({ status: 'cancelled', resolved_at: new Date(), version: 2 })
      .where('id', '=', f.intent.id)
      .execute();
    await expect(c.store.require(accepted.id, f.intent.id, 1)).rejects.toMatchObject({
      status: 403,
    });
    const paid = await fixture(),
      p = await consent(paid),
      a = await p.store.accept(p.write),
      { client } = invoiceClient(paid);
    await new TelegramStarsRuntime(db, keys, 'test', '12345', client).handle(update(paid, true));
    await expect(p.store.require(a.id, paid.intent.id, 1)).rejects.toMatchObject({ status: 403 });
  });
  it('does not trust a copied audit with another identifier as consent authority', async () => {
    const f = await fixture(),
      c = await consent(f),
      accepted = await c.store.accept(c.write);
    const source = await db
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('id', '=', accepted.id)
      .executeTakeFirstOrThrow();
    const forgedId = randomUUID();
    await db
      .insertInto('platform.audit_logs')
      .values({ ...source, id: forgedId })
      .execute();
    await expect(c.store.require(forgedId, f.intent.id, 1)).rejects.toMatchObject({ status: 403 });
    expect((await c.store.require(accepted.id, f.intent.id, 1)).id).toBe(accepted.id);
  });
  it.each([
    { documentDigest: 'provider-secret-must-not-be-retained' },
    { termsVersion: 'private customer prose' },
    { locale: 'https://not-a-locale.invalid' },
    { commandId: 'not-a-native-command' },
  ])('rejects malformed consent metadata before retaining it: %j', async (invalid) => {
    const f = await fixture(),
      c = await consent(f);
    await expect(c.store.accept({ ...c.write, ...invalid })).rejects.toMatchObject({ status: 403 });
    expect(
      await db
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', f.intent.id)
        .where('event_type', '=', 'billing.stars-purchase-consent.v1')
        .execute(),
    ).toHaveLength(0);
  });
  function invoiceRequest(
    f: Awaited<ReturnType<typeof fixture>>,
  ): Parameters<TelegramStarsRuntime['invoice']>[0] {
    return {
      actor: f.actor,
      telegramUserId: f.telegramUserId,
      fundingIntentId: f.intent.id,
      expectedVersion: 1,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: f.attemptWrite.idempotencyKey,
      occurredAt: new Date().toISOString(),
      locale: 'en',
    };
  }
  function invoiceClient(f: Awaited<ReturnType<typeof fixture>>): {
    client: TelegramStarsClient;
    fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  } {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const body = invoiceBody(init?.body);
      return Promise.resolve(
        Response.json({
          ok: true,
          result: {
            message_id: 1,
            chat: { id: Number(f.telegramUserId), type: 'private' },
            from: { id: 12345, is_bot: true },
            invoice: { currency: 'XTR', total_amount: body.prices[0]!.amount },
          },
        }),
      );
    });
    return { client: new TelegramStarsClient(`12345:${'a'.repeat(24)}`, fetcher), fetcher };
  }
  it.each(CREDIT_PACKAGE_DEFINITIONS)(
    'sends the native $code package snapshot and reuses its original encrypted payload',
    async (definition) => {
      const f = await fixture(definition.code),
        { client, fetcher } = invoiceClient(f);
      const runtime = new TelegramStarsRuntime(db, keys, 'test', '12345', client);
      await runtime.onModuleInit();
      // Caller-supplied display/pricing fields cannot replace native purchase facts.
      const request = Object.assign(invoiceRequest(f), { starsAmount: 9999n, credits: 9999n });
      await Promise.all(Array.from({ length: 4 }, () => runtime.invoice(request)));
      for (const [, init] of fetcher.mock.calls) {
        const body = invoiceBody(init?.body);
        expect(body.title).toBe('Buy credits');
        expect(body.description).toBe(`Credits: ${definition.credits}`);
        expect(body.prices).toEqual([{ label: 'Buy credits', amount: Number(definition.stars) }]);
        expect(body.payload).toBe(f.payload.cleartext);
      }
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(
        await db
          .selectFrom('billing.payment_records')
          .select('id')
          .where('pending_payment_id', '=', f.intent.id)
          .execute(),
      ).toHaveLength(1);
    },
  );
  it('creates one new native attempt for concurrent invoice requests', async () => {
    const f = await fixture(),
      { client, fetcher } = invoiceClient(f);
    const intent = await f.funding.createFundingIntent({
      ...f.write,
      intentId: randomUUID(),
      idempotencyKey: randomUUID(),
      target: { type: 'credit_package', packageCode: 'plus' },
    });
    expect(intent.id).not.toBe(f.intent.id);
    const request = {
      ...invoiceRequest(f),
      fundingIntentId: intent.id,
      idempotencyKey: randomUUID(),
    };
    const runtime = new TelegramStarsRuntime(db, keys, 'test', '12345', client);
    await Promise.all(Array.from({ length: 4 }, () => runtime.invoice(request)));
    const attempts = await db
      .selectFrom('billing.payment_records')
      .selectAll()
      .where('pending_payment_id', '=', intent.id)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const payloads = fetcher.mock.calls.map(([, init]) => invoiceBody(init?.body).payload);
    expect(new Set(payloads).size).toBe(1);
    expect(payloads[0]).toBe(
      keys.reveal(attempts[0]!.invoice_payload_ciphertext, attempts[0]!.invoice_payload_key_id),
    );
  });
  it('keeps the original credit amount and price after the catalog offer changes', async () => {
    const f = await fixture(),
      { client, fetcher } = invoiceClient(f);
    const original = await db
      .selectFrom('billing.credit_packages')
      .select(['credit_amount', 'stars_price'])
      .where('code', '=', 'starter')
      .executeTakeFirstOrThrow();
    try {
      await db
        .updateTable('billing.credit_packages')
        .set({ credit_amount: '999', stars_price: '888' })
        .where('code', '=', 'starter')
        .execute();
      await new TelegramStarsRuntime(db, keys, 'test', '12345', client).invoice(invoiceRequest(f));
      const body = invoiceBody(fetcher.mock.calls[0]![1]?.body);
      expect(body.description).toBe('Credits: 10');
      expect(body.prices[0]!.amount).toBe(10);
    } finally {
      await db
        .updateTable('billing.credit_packages')
        .set(original)
        .where('code', '=', 'starter')
        .execute();
    }
  });
  it("cannot present another customer's invoice", async () => {
    const f = await fixture(),
      other = await fixture(),
      { client, fetcher } = invoiceClient(other);
    await expect(
      new TelegramStarsRuntime(db, keys, 'test', '12345', client).invoice({
        ...invoiceRequest(f),
        actor: other.actor,
        telegramUserId: other.telegramUserId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not send a payable invoice again after its native paid receipt is recorded', async () => {
    const f = await fixture(),
      { client, fetcher } = invoiceClient(f);
    const runtime = new TelegramStarsRuntime(db, keys, 'test', '12345', client);
    expect(await runtime.handle(update(f, true))).toBe('notice');
    await expect(runtime.invoice(invoiceRequest(f))).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
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
  it.each([true, false])(
    'commits pre-checkout before answering even when invoice creation is %s',
    async (invoicesEnabled) => {
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
        invoicesEnabled,
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
    },
  );
  it.each([true, false])(
    'records concurrent paid retries after session revocation even when invoice creation is %s',
    async (invoicesEnabled) => {
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
        invoicesEnabled,
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
    },
  );
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
