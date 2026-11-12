import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserSessionActor } from '@nakh/application';
import type { AppConfig } from '@nakh/config';
import { CREDIT_PACKAGE_DEFINITIONS, type CreditPackageCode } from '@nakh/domain';
import {
  createDatabase,
  PostgresUserSessionStore,
  runMigrations,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createRedisConnection } from '@nakh/queue-redis';
import { TelegramBotApiMenuClient } from '@nakh/telegram';
import { referenceFixtureConfig } from '../../../packages/persistence-postgres/src/testing/release-reference-config.js';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import {
  captureStarsPurchasePolicy,
  TelegramStarsCheckoutRuntime,
  type StarsPurchasePolicy,
} from './stars-checkout-runtime.js';
import { TelegramStarsRuntime, TelegramStarsClient } from './stars-runtime.js';
import { TelegramStarsKeys } from './stars-keys.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
const token = `12345:${'a'.repeat(24)}`,
  key = Buffer.alloc(32, 114);
type RenderedTelegramMenu = Parameters<TelegramBotApiMenuClient['sendMenu']>[1];
type Invoice = { payload: string; prices: { label: string; amount: number }[]; chat_id: string };
type Home = (recipient: string, actor: UserSessionActor) => Promise<void>;
type Fixture = {
  runtime: TelegramStarsCheckoutRuntime;
  native: TelegramStarsRuntime;
  actor: UserSessionActor;
  sender: string;
  menus: RenderedTelegramMenu[];
  invoices: Invoice[];
  home: ReturnType<typeof vi.fn<Home>>;
  policy: StarsPurchasePolicy;
  config: AppConfig;
  client: TelegramBotApiMenuClient;
};
describe.skipIf(url === undefined || redisUrl === undefined)(
  'owned Stars checkout through native offers, consent and Redis',
  () => {
    let db: NakhDatabase,
      redis: ReturnType<typeof createRedisConnection>,
      isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    let serial = 9100000;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm9_checkout');
      await runMigrations(isolated.url, resolve('migrations'));
      db = createDatabase({
        url: isolated.url,
        poolMax: 12,
        statementTimeoutMs: 10000,
        lockTimeoutMs: 5000,
      });
      redis = createRedisConnection(redisUrl!);
    }, 120000);
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      await redis?.quit();
      await db?.destroy();
      await isolated?.destroy();
    });
    async function fixture(): Promise<Fixture> {
      const userId = randomUUID(),
        sender = String(serial++),
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
          telegram_user_id: sender,
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
        .insertInto('identity.guest_preview_counters')
        .values({
          user_id: userId,
          preview_count: 0,
          limit_count: 3,
          first_preview_at: null,
          last_preview_at: null,
        })
        .execute();
      await db
        .insertInto('billing.credit_accounts')
        .values({ user_id: userId, created_at: now, updated_at: now })
        .execute();
      const grant = await new PostgresUserSessionStore(db).issue(
        { userId, productEpoch: 0 },
        randomUUID(),
      );
      if (!grant) throw new Error('Missing synthetic native grant');
      const actor: UserSessionActor = {
        kind: 'user',
        userId,
        productEpoch: 0,
        sessionGrantId: grant.id,
      };
      const policy = await captureStarsPurchasePolicy(db, 'NakhSupport'),
        base = referenceFixtureConfig();
      const config: AppConfig = {
        ...base,
        environment: 'test',
        telegram: {
          ...base.telegram,
          starsEnabled: true,
          starsInvoiceCreationEnabled: true,
          accountMenuEnabled: true,
          signupEnabled: true,
          publicSupportUsername: 'NakhSupport',
          starsPurchaseApprovalDigest: policy.digest,
        },
        redis: { ...base.redis, queuePrefix: 'checkout-' + randomUUID() },
      };
      const menus: RenderedTelegramMenu[] = [],
        invoices: Invoice[] = [],
        home = vi.fn<Home>().mockResolvedValue(undefined);
      const client = new TelegramBotApiMenuClient(token);
      vi.spyOn(client, 'sendMenu').mockImplementation((_recipient, menu) => {
        menus.push(structuredClone(menu));
        return Promise.resolve();
      });
      vi.spyOn(client, 'answerCallback').mockResolvedValue(undefined);
      const keys = new TelegramStarsKeys(
        JSON.stringify({
          activeKeyId: 'v1',
          digestKey: Buffer.alloc(32, 5).toString('base64url'),
          keys: [
            {
              id: 'v1',
              invoiceKey: Buffer.alloc(32, 1).toString('base64url'),
              evidenceKey: Buffer.alloc(32, 2).toString('base64url'),
            },
          ],
        }),
      );
      const native = new TelegramStarsRuntime(
        db,
        keys,
        'test',
        '12345',
        new TelegramStarsClient(token, (_url, init) => {
          if (typeof init?.body !== 'string') throw new Error('Missing synthetic invoice');
          const body = JSON.parse(init.body) as Invoice;
          invoices.push(body);
          return Promise.resolve(
            Response.json({
              ok: true,
              result: {
                message_id: serial++,
                chat: { id: Number(sender), type: 'private' },
                from: { id: 12345, is_bot: true },
                invoice: { currency: 'XTR', total_amount: body.prices[0]!.amount },
              },
            }),
          );
        }),
        true,
        true,
      );
      const runtime = new TelegramStarsCheckoutRuntime(
        config,
        db,
        db,
        redis,
        '12345',
        key,
        client,
        native,
        home,
      );
      await native.onModuleInit();
      await runtime.onModuleInit();
      return { runtime, native, actor, sender, menus, invoices, home, policy, config, client };
    }
    function callback(f: Fixture, data: string): Record<string, unknown> {
      const id = serial++;
      return {
        update_id: id,
        callback_query: {
          id: 'checkout-' + id,
          data,
          from: { id: Number(f.sender), is_bot: false },
          message: {
            from: { id: 12345, is_bot: true },
            chat: { id: Number(f.sender), type: 'private' },
          },
        },
      };
    }
    function button(menu: RenderedTelegramMenu, text: string): string {
      const data = menu.replyMarkup.inline_keyboard
        .flat()
        .find((b) => b.text === text)?.callback_data;
      if (!data) throw new Error('Missing synthetic checkout button');
      return data;
    }
    async function review(
      f: Fixture,
      code: CreditPackageCode = 'starter',
    ): Promise<{ confirm: Record<string, unknown>; cancel: Record<string, unknown> }> {
      await f.runtime.openPackages(f.sender, f.actor);
      const p = f.policy.packages.find((p) => p.code === code)!;
      const select = button(f.menus.at(-1)!, `${p.credits} credits for ${p.stars} Telegram Stars`);
      expect(await f.runtime.handleNavigation(callback(f, select))).toBe('notice');
      const menu = f.menus.at(-1)!;
      expect(menu.text).toContain('Nakh purchase terms');
      expect(menu.text).toContain('Telegram support cannot resolve');
      expect(f.invoices).toHaveLength(0);
      return {
        confirm: callback(f, button(menu, 'I agree: open Telegram payment')),
        cancel: callback(f, button(menu, 'Cancel purchase')),
      };
    }
    it.each(CREDIT_PACKAGE_DEFINITIONS)(
      'presents $code and records one consent before sending its exact invoice',
      async (definition) => {
        const f = await fixture(),
          r = await review(f, definition.code);
        expect(await f.runtime.handleNavigation(r.confirm)).toBe('notice');
        expect(f.invoices).toHaveLength(1);
        expect(f.invoices[0]!.prices).toEqual([
          { label: 'Buy credits', amount: Number(definition.stars) },
        ]);
        expect(
          await db
            .selectFrom('platform.audit_logs')
            .select('metadata')
            .where('actor_user_id', '=', f.actor.userId)
            .where('event_type', '=', 'billing.stars-purchase-consent.v1')
            .execute(),
        ).toHaveLength(1);
        expect(
          (
            await db
              .selectFrom('billing.credit_accounts')
              .select('balance')
              .where('user_id', '=', f.actor.userId)
              .executeTakeFirstOrThrow()
          ).balance,
        ).toBe('0');
        expect(
          await db
            .selectFrom('billing.credit_transactions')
            .select('id')
            .where('user_id', '=', f.actor.userId)
            .execute(),
        ).toHaveLength(0);
      },
    );
    it('retries concurrent identical confirmations with one native consent, attempt and encrypted payload', async () => {
      const f = await fixture(),
        r = await review(f);
      await Promise.all(Array.from({ length: 4 }, () => f.runtime.handleNavigation(r.confirm)));
      expect(f.invoices).toHaveLength(4);
      expect(new Set(f.invoices.map((i) => i.payload)).size).toBe(1);
      expect(
        await db
          .selectFrom('billing.payment_records')
          .select('id')
          .where('user_id', '=', f.actor.userId)
          .execute(),
      ).toHaveLength(1);
      expect(
        await db
          .selectFrom('platform.audit_logs')
          .select('id')
          .where('actor_user_id', '=', f.actor.userId)
          .where('event_type', '=', 'billing.stars-purchase-consent.v1')
          .execute(),
      ).toHaveLength(1);
    });
    it('makes cancel and agree compete for the same original menu transition', async () => {
      const f = await fixture(),
        r = await review(f);
      await Promise.all([
        f.runtime.handleNavigation(r.cancel),
        f.runtime.handleNavigation(r.confirm),
      ]);
      expect(f.home.mock.calls.length + f.invoices.length).toBe(1);
      expect(
        await db
          .selectFrom('platform.audit_logs')
          .select('id')
          .where('actor_user_id', '=', f.actor.userId)
          .where('event_type', '=', 'billing.stars-purchase-consent.v1')
          .execute(),
      ).toHaveLength(f.invoices.length);
    });
    it('rejects another account, a forged namespace and a revoked original grant', async () => {
      const f = await fixture(),
        other = await fixture(),
        r = await review(f);
      const raw = r.confirm.callback_query as { data: string };
      await expect(other.runtime.handleNavigation(callback(other, raw.data))).rejects.toMatchObject(
        { status: 403 },
      );
      expect(await f.runtime.handleNavigation(callback(f, raw.data.replace('m9b:', 'm9a:')))).toBe(
        'unhandled',
      );
      await new PostgresUserSessionStore(db).revoke(f.actor, f.actor.sessionGrantId, randomUUID());
      await expect(f.runtime.handleNavigation(r.confirm)).rejects.toMatchObject({ status: 403 });
      expect(f.invoices).toHaveLength(0);
      expect(other.invoices).toHaveLength(0);
    });
    it('rejects an expired navigation envelope without issuing a replacement grant', async () => {
      const f = await fixture(),
        r = await review(f),
        now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60 * 1000);
      try {
        await expect(f.runtime.handleNavigation(r.confirm)).rejects.toMatchObject({ status: 403 });
      } finally {
        clock.mockRestore();
      }
      expect(f.invoices).toHaveLength(0);
    });
    it('does not substitute a changed catalog price after the customer selected an approved package', async () => {
      const f = await fixture();
      await f.runtime.openPackages(f.sender, f.actor);
      const select = button(f.menus.at(-1)!, '10 credits for 10 Telegram Stars');
      const old = await db
        .selectFrom('billing.credit_packages')
        .select('stars_price')
        .where('code', '=', 'starter')
        .executeTakeFirstOrThrow();
      try {
        await db
          .updateTable('billing.credit_packages')
          .set({ stars_price: '999' })
          .where('code', '=', 'starter')
          .execute();
        await expect(f.runtime.handleNavigation(callback(f, select))).rejects.toMatchObject({
          status: 403,
        });
        expect(f.invoices).toHaveLength(0);
      } finally {
        await db
          .updateTable('billing.credit_packages')
          .set(old)
          .where('code', '=', 'starter')
          .execute();
      }
    });
    it('requires explicit approval of the exact public terms, contact and package policy', async () => {
      const f = await fixture();
      expect((await captureStarsPurchasePolicy(db, 'NakhSupport')).digest).toBe(f.policy.digest);
      const invalid = new TelegramStarsCheckoutRuntime(
        {
          ...f.config,
          telegram: { ...f.config.telegram, starsPurchaseApprovalDigest: 'f'.repeat(64) },
        },
        db,
        db,
        redis,
        '12345',
        key,
        f.client,
        f.native,
        f.home,
      );
      await expect(invalid.onModuleInit()).rejects.toThrow('policy approval unavailable');
      expect(f.invoices).toHaveLength(0);
    });
    it('keeps public terms available during an invoice pause without registering an account or grant', async () => {
      const f = await fixture();
      Object.defineProperty(f.native, 'invoiceCreationEnabled', { value: false });
      const before = await db.selectFrom('identity.users').select('id').execute();
      expect(
        await f.runtime.handle({
          update_id: serial++,
          message: {
            text: '/terms',
            from: { id: 999991, is_bot: false },
            chat: { id: 999991, type: 'private' },
          },
        }),
      ).toBe('notice');
      expect(f.menus.at(-1)!.text).toContain('@NakhSupport');
      expect(await db.selectFrom('identity.users').select('id').execute()).toHaveLength(
        before.length,
      );
      await expect(f.runtime.openPackages(f.sender, f.actor)).rejects.toMatchObject({
        status: 403,
      });
      expect(f.invoices).toHaveLength(0);
    });
    it('preserves paid callbacks after a shop-policy mismatch while invoices and signup are paused', async () => {
      const f = await fixture(),
        r = await review(f);
      await f.runtime.handleNavigation(r.confirm);
      await new PostgresUserSessionStore(db).revoke(f.actor, f.actor.sessionGrantId, randomUUID());
      Object.defineProperty(f.native, 'invoiceCreationEnabled', { value: false });
      const paused = new TelegramStarsCheckoutRuntime(
        {
          ...f.config,
          telegram: {
            ...f.config.telegram,
            signupEnabled: false,
            starsInvoiceCreationEnabled: false,
            starsPurchaseApprovalDigest: 'f'.repeat(64),
          },
        },
        db,
        db,
        redis,
        '12345',
        key,
        f.client,
        f.native,
        f.home,
      );
      await paused.onModuleInit();
      const invoice = f.invoices[0]!;
      const payment = {
        update_id: serial++,
        message: {
          from: { id: Number(f.sender), is_bot: false },
          successful_payment: {
            currency: 'XTR',
            total_amount: invoice.prices[0]!.amount,
            invoice_payload: invoice.payload,
            telegram_payment_charge_id: 'paused-checkout-' + serial,
            provider_payment_charge_id: '',
          },
        },
      };
      expect(await paused.handle(payment)).toBe('notice');
      const row = await db
        .selectFrom('billing.payment_records')
        .select('status')
        .where('user_id', '=', f.actor.userId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('paid');
      expect(
        await paused.handle({
          update_id: serial++,
          message: {
            text: '/terms',
            from: { id: Number(f.sender), is_bot: false },
            chat: { id: Number(f.sender), type: 'private' },
          },
        }),
      ).toBe('notice');
      expect(f.menus.at(-1)!.text).toContain('/paysupport');
      expect(f.menus.at(-1)!.text).not.toContain('Nakh purchase terms');
    });
  },
);
