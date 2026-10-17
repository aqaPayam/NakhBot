import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@nakh/config';
import {
  PostgresAccountReturnStore,
  PostgresFundingStore,
  PostgresRefundStore,
  PostgresStarsRefundAuthorityStore,
  PostgresTelegramStarsReceiptStore,
  PostgresUserSessionStore,
  TelegramStarsKeys,
  createDatabase,
  runMigrations,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createAccountReturnFixture } from '../../../packages/persistence-postgres/src/testing/account-return-fixture.js';
import { PaymentFulfillmentProcessor } from './payment-fulfillment-processor.js';
import { createTelegramStarsRefundRuntime } from './stars-refund-runtime.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
const token = `12345:${'a'.repeat(24)}`,
  botDigest = createHash('sha256').update('12345').digest('hex');
const key = (n: number): string => Buffer.alloc(32, n).toString('base64url');
const old = { id: 'v1', invoiceKey: key(91), evidenceKey: key(92) },
  next = { id: 'v2', invoiceKey: key(93), evidenceKey: key(94) };
const ring = JSON.stringify({ activeKeyId: 'v1', digestKey: key(95), keys: [old] });
const rotated = JSON.stringify({ activeKeyId: 'v2', digestKey: key(95), keys: [old, next] });

describe.skipIf(url === undefined)('original financial Stars refund process', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_stars_refund');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 12,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });

  function environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NAKH_ENV: 'test',
      NAKH_SERVICE_NAME: 'worker',
      NAKH_RELEASE: 'native-refund-process',
      NAKH_DATABASE_URL: isolated.url,
      NAKH_REDIS_URL: redisUrl ?? 'redis://127.0.0.1:1',
      NAKH_QUEUE_PREFIX: `refund_${randomUUID().replaceAll('-', '')}`,
      NAKH_TELEGRAM_BOT_TOKEN_REF: 'M9_REFUND_BOT',
      M9_REFUND_BOT: token,
      NAKH_TELEGRAM_WEBHOOK_SECRET: 'synthetic-refund-webhook-secret-000000',
      NAKH_STARS_KEY_RING_REF: 'M9_REFUND_KEYS',
      M9_REFUND_KEYS: rotated,
      NAKH_TELEGRAM_STARS_REFUNDS_ENABLED: 'true',
      NAKH_TELEGRAM_STARS_ENABLED: 'false',
      NAKH_TELEGRAM_SIGNUP_ENABLED: 'false',
      NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'false',
      NAKH_TELEGRAM_GUEST_PREVIEW_ENABLED: 'false',
      NAKH_TELEGRAM_EXPLORE_ENABLED: 'false',
      NAKH_TELEGRAM_REPORTS_ENABLED: 'false',
      NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: 'false',
      NAKH_TELEGRAM_NOTIFICATION_DELIVERY_ENABLED: 'false',
      NAKH_DELETION_WORKER_ENABLED: 'false',
      NAKH_MEDIA_INGESTION_ENABLED: 'false',
      NAKH_MEDIA_CLEANUP_ENABLED: 'false',
      NAKH_MEDIA_CACHE_PURGE_ENABLED: 'false',
      NAKH_TELEMETRY_ENABLED: 'false',
      NAKH_R2_ENDPOINT: 'https://r2.invalid',
      NAKH_R2_BUCKET: 'test',
      NAKH_R2_ACCESS_KEY_REF: 'fake',
      NAKH_R2_SECRET_KEY_REF: 'fake',
      NAKH_MEDIA_CDN_HOST: 'media.invalid',
      NAKH_MEDIA_SIGNING_KEY_REF: 'M9_UNUSED_MEDIA_KEY',
      NODE_OPTIONS: '',
    };
  }
  function resolveSecret(reference: string): string {
    const value = environment()[reference];
    if (value === undefined) throw new Error('Missing synthetic refund secret.');
    return value;
  }
  async function captured(
    providerDigest = botDigest,
    mismatchedEvidence = false,
  ): Promise<{
    refundId: string;
    paymentId: string;
    userId: string;
    telegramUserId: string;
    charge: string;
  }> {
    const keys = new TelegramStarsKeys(ring),
      charge = `refund-charge:${randomUUID()}`;
    let paymentId = '',
      telegramUserId = '',
      oldGrantId = '';
    const fixture = await createAccountReturnFixture(database, {
      beforeDeletion: async (userId) => {
        await database
          .updateTable('identity.accounts')
          .set({ state: 'active' })
          .where('user_id', '=', userId)
          .execute();
        telegramUserId = (
          await database
            .selectFrom('identity.telegram_identities')
            .select('telegram_user_id')
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow()
        ).telegram_user_id;
        oldGrantId = (await new PostgresUserSessionStore(database).issue(
          { userId, productEpoch: 0 },
          randomUUID(),
        ))!.id;
        const funding = new PostgresFundingStore(database),
          payload = keys.issue();
        const intent = await funding.createFundingIntent({
          intentId: randomUUID(),
          userId,
          funding: 'stars',
          target: { type: 'credit_package', packageCode: 'starter' },
          idempotencyKey: randomUUID(),
        });
        const attempt = await funding.prepareStarsAttempt({
          paymentRecordId: randomUUID(),
          fundingIntentId: intent.id,
          expectedVersion: 1,
          userId,
          idempotencyKey: randomUUID(),
          providerEnvironment: 'test',
          providerBotIdDigest: providerDigest,
          payload,
        });
        paymentId = attempt.paymentRecordId;
        const providerEventId = String(Math.floor(Math.random() * 1000000000) + 1);
        expect(
          await new PostgresTelegramStarsReceiptStore(
            database,
            { uuid: randomUUID },
            keys,
          ).recordSuccessfulPayment({
            providerEventId,
            telegramUserId,
            invoicePayload: payload.cleartext,
            currency: 'XTR',
            totalAmount: attempt.starsAmount,
            providerEnvironment: 'test',
            providerBotIdDigest: providerDigest,
            telegramChargeId: charge,
            evidence: keys.protectEvidence({
              eventType: 'successful_payment',
              providerEventId,
              telegramUserId,
              invoicePayload: payload.cleartext,
              currency: 'XTR',
              totalAmount: attempt.starsAmount.toString(),
              environment: 'test',
              botDigest: mismatchedEvidence ? 'e'.repeat(64) : providerDigest,
              telegramChargeId: charge,
            }),
          }),
        ).toMatchObject({ outcome: 'receipt_recorded' });
      },
      beforeEvidenceCheckpoint: async () => {
        expect(
          await new PaymentFulfillmentProcessor(
            PostgresTelegramStarsReceiptStore.forFulfillment(database),
            { uuid: randomUUID },
            `refund-fulfill-${randomUUID()}`,
          ).processNext(),
        ).toMatchObject({ outcome: 'correction_required' });
      },
    });
    const commandId = randomUUID();
    await new PostgresAccountReturnStore(database, fixture.control).return({
      commandId,
      requestId: commandId,
      commandType: 'account.return',
      schemaVersion: 1,
      actor: { kind: 'user', userId: fixture.userId },
      idempotencyKey: commandId,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: fixture.version },
    });
    expect(
      await new PostgresUserSessionStore(database).current(
        { userId: fixture.userId, productEpoch: 0 },
        oldGrantId,
      ),
    ).toBeUndefined();
    expect(
      await database
        .selectFrom('identity.accounts')
        .select(['state', 'product_epoch'])
        .where('user_id', '=', fixture.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'guest', product_epoch: 1 });
    const refund = await database
      .selectFrom('billing.refund_records')
      .select('id')
      .where('payment_record_id', '=', paymentId)
      .executeTakeFirstOrThrow();
    return { refundId: refund.id, paymentId, userId: fixture.userId, telegramUserId, charge };
  }
  async function observed(
    refundId: string,
    status: 'processed' | 'failed_retryable',
    failure: () => string | undefined,
    details: () => string,
  ): Promise<void> {
    for (let n = 0; n < 1000; n++) {
      const diagnostic = failure();
      if (diagnostic !== undefined)
        throw new Error(`Native worker exited before settlement: ${diagnostic}`);
      const row = await database
        .selectFrom('billing.refund_records')
        .select('status')
        .where('id', '=', refundId)
        .executeTakeFirstOrThrow();
      if (row.status === status) return;
      await pause(20);
    }
    throw new Error(`Refund process did not settle: ${details()}`);
  }

  it.skipIf(redisUrl === undefined)(
    'starts the ordinary worker and refunds the original retained payer after complete deletion and Return',
    async () => {
      const f = await captured(),
        directory = await mkdtemp(join(tmpdir(), 'nakh-refund-worker-')),
        preload = join(directory, 'provider.mjs');
      await writeFile(
        preload,
        `globalThis.fetch = async (url, options) => {
      if (url !== ${JSON.stringify(`https://api.telegram.org/bot${token}/refundStarPayment`)}) throw Error('Unexpected provider call');
      process.send({type:'refund',body:JSON.parse(options.body)});
      await new Promise(resolve => process.once('message', resolve));
      return Response.json({ok:true,result:true});
    };
    let stopping = false;
    const stop = () => { if(stopping && process.listenerCount('SIGTERM') > 0) { stopping = false; process.emit('SIGTERM'); process.disconnect(); } };
    process.on('newListener', name => { if(name === 'SIGTERM') queueMicrotask(stop); });
    process.on('message', message => { if(message?.stop) { stopping = true; stop(); } });
    `,
      );
      let child: ChildProcess | undefined, stopped: Promise<unknown> | undefined;
      const requests: unknown[] = [],
        phases: string[] = [];
      try {
        child = spawn(
          process.execPath,
          [
            ...process.execArgv.filter((a) => a === '--no-opt' || a === '--jitless'),
            '--import',
            pathToFileURL(preload).href,
            resolve('apps/worker/dist/main.js'),
          ],
          { env: environment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
        );
        stopped = once(child, 'exit');
        let exitCode: number | null | undefined,
          diagnostic = '';
        child.once('exit', (code) => {
          exitCode = code;
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (text: string) => {
          diagnostic = (diagnostic + text).replaceAll(token, '[synthetic-token]').slice(-2000);
        });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (text: string) => {
          diagnostic = (diagnostic + text).replaceAll(token, '[synthetic-token]').slice(-4000);
        });
        const actor = child;
        actor.on('message', (message: unknown) => {
          if (
            typeof message !== 'object' ||
            message === null ||
            !('type' in message) ||
            message.type !== 'refund' ||
            !('body' in message)
          )
            return;
          requests.push(message.body);
          void database
            .selectFrom('billing.refund_records')
            .select('provider_progress')
            .where('id', '=', f.refundId)
            .executeTakeFirstOrThrow()
            .then((row) => {
              phases.push(row.provider_progress);
              actor.send({ release: true });
            });
        });
        await observed(
          f.refundId,
          'processed',
          () => (exitCode === undefined ? undefined : `code=${exitCode}; ${diagnostic}`),
          () => diagnostic,
        );
        expect(requests).toEqual([
          { user_id: Number(f.telegramUserId), telegram_payment_charge_id: f.charge },
        ]);
        expect(phases).toEqual(['call_started']);
        expect(
          (
            await database
              .selectFrom('billing.payment_records')
              .select('status')
              .where('id', '=', f.paymentId)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe('refunded');
        actor.send({ stop: true });
        expect(await stopped).toEqual([0, null]);
        child = undefined;
      } finally {
        if (child !== undefined) {
          child.kill();
          await stopped;
        }
        await unlink(preload);
        await rmdir(directory);
      }
    },
  );
  it('quarantines lost provider acknowledgement across competing polls and process recreation', async () => {
    const f = await captured();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const request = vi.fn<typeof fetch>(async () => {
      entered();
      await gate;
      throw new Error('Synthetic lost acknowledgement');
    });
    vi.stubGlobal('fetch', request);
    const config = parseConfig(environment()),
      runtime = createTelegramStarsRefundRuntime({
        config,
        database,
        owner: 'refund-unknown',
        resolveSecret,
      })!;
    try {
      await runtime.verifyCustody();
      const pending = Promise.all(Array.from({ length: 10 }, () => runtime.processNext()));
      await Promise.race([
        ready,
        pending.then(() => {
          throw new Error('Refund provider call was not entered.');
        }),
      ]);
      let drained = false;
      const closing = runtime.close().then(() => {
        drained = true;
      });
      expect(await runtime.processNext()).toEqual({ outcome: 'idle' });
      expect(drained).toBe(false);
      release();
      const results = await pending;
      await closing;
      expect(results.filter((r) => r.outcome === 'reconciliation_required')).toHaveLength(1);
      expect(request).toHaveBeenCalledOnce();
      const restarted = createTelegramStarsRefundRuntime({
        config,
        database,
        owner: 'refund-restarted',
        resolveSecret,
      })!;
      expect(await restarted.processNext()).toEqual({ outcome: 'idle' });
      await restarted.close();
      expect(
        await database
          .selectFrom('billing.refund_records')
          .select(['status', 'provider_progress'])
          .where('id', '=', f.refundId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'failed_retryable', provider_progress: 'call_started' });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      release();
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });
  it('claims only the configured bot and environment', async () => {
    const foreign = await captured('f'.repeat(64)),
      own = await captured();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: true }));
    vi.stubGlobal('fetch', request);
    const runtime = createTelegramStarsRefundRuntime({
      config: parseConfig(environment()),
      database,
      owner: 'refund-own-bot',
      resolveSecret,
    })!;
    try {
      expect(await runtime.processNext()).toEqual({ outcome: 'processed' });
      expect(request).toHaveBeenCalledOnce();
      expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
        user_id: Number(own.telegramUserId),
        telegram_payment_charge_id: own.charge,
      });
      expect(
        (
          await database
            .selectFrom('billing.refund_records')
            .select('provider_progress')
            .where('id', '=', foreign.refundId)
            .executeTakeFirstOrThrow()
        ).provider_progress,
      ).toBe('not_started');
      expect(
        await new PostgresRefundStore(database).claimStarsRefunds({
          owner: 'foreign-reader',
          leaseMs: 60000,
          limit: 1,
          provider: { environment: 'production', botIdDigest: botDigest },
        }),
      ).toEqual([]);
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });
  it('refuses authentic encrypted evidence whose original provider binding disagrees with its receipt', async () => {
    const f = await captured(botDigest, true),
      request = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', request);
    const runtime = createTelegramStarsRefundRuntime({
      config: parseConfig(environment()),
      database,
      owner: 'refund-mismatched-facts',
      resolveSecret,
    })!;
    try {
      expect(await runtime.processNext()).toEqual({ outcome: 'retryable' });
      expect(request).not.toHaveBeenCalled();
      expect(
        await database
          .selectFrom('billing.refund_records')
          .select(['status', 'provider_progress'])
          .where('id', '=', f.refundId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'failed_retryable', provider_progress: 'not_started' });
    } finally {
      await runtime.close();
      vi.unstubAllGlobals();
    }
  });
  it('requires the exact current refund lease, owner, charge and amount before revealing provider authority', async () => {
    const f = await captured(),
      store = new PostgresRefundStore(database),
      provider = { environment: 'test' as const, botIdDigest: botDigest };
    const [claim] = await store.claimStarsRefunds({
      owner: 'refund-authority',
      leaseMs: 60000,
      limit: 1,
      provider,
    });
    expect(claim?.refundRecordId).toBe(f.refundId);
    expect(await store.beginProviderCall(claim!)).toBe(true);
    const authority = new PostgresStarsRefundAuthorityStore(
      database,
      new TelegramStarsKeys(rotated),
    );
    for (const changed of [
      { ...claim!, fenceToken: claim!.fenceToken + 1n },
      { ...claim!, owner: 'borrowed' },
      { ...claim!, telegramChargeId: 'borrowed-charge' },
      { ...claim!, starsAmount: claim!.starsAmount + 1n },
    ])
      expect(await authority.resolve(changed, provider)).toBeUndefined();
    expect(
      await authority.resolve(claim!, { ...provider, environment: 'production' }),
    ).toBeUndefined();
    expect(await authority.resolve(claim!, provider)).toEqual({
      telegramUserId: f.telegramUserId,
      telegramChargeId: f.charge,
    });
    expect(
      await store.recordProviderFailure({
        ...claim!,
        kind: 'retryable_not_sent',
        errorCode: 'native_no_provider_call',
        delayMs: 60000,
      }),
    ).toBe(true);
  });
});
