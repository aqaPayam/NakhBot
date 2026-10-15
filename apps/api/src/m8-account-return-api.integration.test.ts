import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountControlSessionService } from '@nakh/application';
import { parseConfig } from '@nakh/config';
import {
  createDatabase,
  runMigrations,
  createPostgresAccountControls,
  createPostgresUserSessions,
  PostgresAccountControlSessionStore,
  PostgresAccountDeletionStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createAccountReturnFixture } from '../../../packages/persistence-postgres/src/testing/account-return-fixture.js';
import { createAccountDeletionApi } from './m8-account-deletion-api.js';
import { ApiExceptionFilter } from './app.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  key = Buffer.alloc(32, 121);
@Module({})
class ReturnTestHost {}
// Native completed Roots/approval are real; provider absence, protected-factor
// verification and configured producer-drain evidence are synthetic fixtures.
describe.skipIf(url === undefined)(
  'production own Return HTTP and native original-grant replay',
  () => {
    let database: NakhDatabase,
      app: NestFastifyApplication,
      isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm8_return_api');
      await runMigrations(isolated.url, resolve('migrations'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      vi.stubEnv('M8_RETURN_CONTROL_KEY', key.toString('base64url'));
      vi.stubEnv('M8_RETURN_CONFIRM_KEY', Buffer.alloc(32, 122).toString('base64url'));
      const config = parseConfig({
        NAKH_ENV: 'test',
        NAKH_SERVICE_NAME: 'api',
        NAKH_DATABASE_URL: isolated.url,
        NAKH_REDIS_URL: 'redis://test',
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'fake',
        NAKH_TELEGRAM_WEBHOOK_SECRET: '12345678901234567890123456789012',
        NAKH_R2_ENDPOINT: 'https://r2.invalid',
        NAKH_R2_BUCKET: 'test',
        NAKH_R2_ACCESS_KEY_REF: 'fake',
        NAKH_R2_SECRET_KEY_REF: 'fake',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'NAKH_MEDIA_SIGNING_KEY',
        NAKH_DELETION_API_ENABLED: 'true',
        NAKH_RETURN_API_ENABLED: 'true',
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'a'.repeat(64),
        NAKH_ACCOUNT_CONTROL_KEY_REF: 'M8_RETURN_CONTROL_KEY',
        NAKH_DELETION_CONFIRMATION_KEY_REF: 'M8_RETURN_CONFIRM_KEY',
      });
      expect(
        createAccountDeletionApi(
          { ...config, deletion: { ...config.deletion, returnApiEnabled: false } },
          database,
        ),
      ).toHaveLength(1);
      const modules = createAccountDeletionApi(config, database);
      expect(modules).toHaveLength(2);
      app = await NestFactory.create<NestFastifyApplication>(
        { module: ReturnTestHost, imports: modules },
        new FastifyAdapter(),
        { logger: false },
      );
      app.useGlobalFilters(new ApiExceptionFilter(pino({ enabled: false })));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });
    beforeEach(async () => {
      // Another case may deliberately leave a next-life tombstone pending. Keep
      // its work out of this new fixture's single-claim bootstrap, without
      // pretending the prior case completed any provider cleanup.
      await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,
        available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(database);
    });
    afterAll(async () => {
      await app?.close();
      await database?.destroy();
      await isolated?.destroy();
      vi.unstubAllEnvs();
    });
    const controls = (): AccountControlSessionService =>
      createPostgresAccountControls(database, key);
    function payload(version: number): Record<string, unknown> {
      return {
        commandId: randomUUID(),
        commandType: 'account.return',
        schemaVersion: 1,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { expectedAccountVersion: version },
      };
    }
    async function post(
      token: string,
      body: Record<string, unknown>,
    ): Promise<Awaited<ReturnType<NestFastifyApplication['inject']>>> {
      return app.inject({
        method: 'POST',
        url: '/v1/account/return/confirm',
        headers: { authorization: 'Bearer ' + token },
        payload: body,
      });
    }
    it('commits once across twenty HTTP retries, preserves originals and denies old authority after a later tombstone', async () => {
      const f = await createAccountReturnFixture(database),
        life = { userId: f.userId, productEpoch: 0 };
      const token = (await controls().issue(life, randomUUID())).accountControlToken,
        body = payload(f.version);
      const before = (
        await sql`SELECT to_jsonb(c) AS counter FROM identity.guest_preview_counters c WHERE user_id=${f.userId}::uuid`.execute(
          database,
        )
      ).rows;
      const responses = await Promise.all(Array.from({ length: 20 }, () => post(token, body)));
      expect(responses.map((r) => r.statusCode)).toEqual(Array.from({ length: 20 }, () => 200));
      expect(
        responses.filter((r) => r.json<{ replayed: boolean }>().replayed === false),
      ).toHaveLength(1);
      for (const r of responses) {
        expect(r.headers['cache-control']).toBe('no-store');
        expect(Object.keys(r.json()).sort()).toEqual(['accountVersion', 'replayed', 'returned']);
      }
      expect(
        await controls().authenticate({ bearerToken: token, audience: 'account_control' }),
      ).toBeUndefined();
      expect(
        await createPostgresUserSessions(database, key).authenticate({
          bearerToken: token,
          audience: 'user',
        }),
      ).toBeUndefined();
      expect(
        await controls().authenticateReturn({ bearerToken: token, audience: 'account_return' }),
      ).toMatchObject({ scope: 'account_return', ...life });
      const product = (
        await createPostgresUserSessions(database, key).issue(
          { userId: f.userId, productEpoch: 1 },
          randomUUID(),
        )
      ).userSessionToken;
      expect((await post(product, body)).statusCode).toBe(401);
      expect(
        await database
          .selectFrom('identity.accounts')
          .select(['state', 'version', 'product_epoch'])
          .where('user_id', '=', f.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'guest', version: f.version + 1, product_epoch: 1 });
      expect(
        (
          await sql`SELECT to_jsonb(c) AS counter FROM identity.guest_preview_counters c WHERE user_id=${f.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE event_type='account.returned.v1' AND actor_user_id=${f.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect((await post(token, { ...body, requestId: randomUUID() })).statusCode).toBe(409);
      expect(
        (await post(token, { ...body, data: { expectedAccountVersion: f.version + 1 } }))
          .statusCode,
      ).toBe(409);
      const next = { userId: f.userId, productEpoch: 1 },
        grant = await new PostgresAccountControlSessionStore(database).issue(next, randomUUID());
      const deletion = new PostgresAccountDeletionStore(
        database,
        { activeKeyId: 'api-return', keys: new Map([['api-return', Buffer.alloc(32, 123)]]) },
        { kind: 'user', scope: 'account_control', ...next, controlGrantId: grant!.id },
      );
      const prepared = await deletion.prepare({
          actor: { kind: 'user', userId: f.userId },
          requestId: randomUUID(),
          expectedAccountVersion: f.version + 1,
        }),
        id = randomUUID();
      await deletion.request({
        commandId: id,
        commandType: 'account.delete',
        schemaVersion: 1,
        actor: { kind: 'user', userId: f.userId },
        requestId: randomUUID(),
        idempotencyKey: id,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          expectedAccountVersion: f.version + 1,
          confirmationToken: prepared.confirmationToken,
        },
      });
      expect((await post(token, body)).statusCode).toBe(401);
      expect(
        (
          await sql`SELECT identity.account_return_completed(${f.recordId}::uuid) AS original,billing.deletion_credit_cutover_valid(${f.recordId}::uuid) AS financial`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ original: true, financial: true }]);
    });
    it('requires the separate approved Root and rejects forged credentials and identity selectors', async () => {
      const f = await createAccountReturnFixture(database, { approve: false }),
        life = { userId: f.userId, productEpoch: 0 };
      const token = (await controls().issue(life, randomUUID())).accountControlToken,
        body = payload(f.version);
      expect((await post(token, body)).statusCode).toBe(409);
      for (const credential of [
        token + '=',
        token.replace('v1.ac.', 'v1.us.'),
        'invalid-control-credential',
      ])
        expect((await post(credential, body)).statusCode).toBe(401);
      expect(
        (await post(token, { ...body, actor: { kind: 'user', userId: randomUUID() } })).statusCode,
      ).toBe(400);
      expect(
        (
          await post(token, {
            ...body,
            data: { expectedAccountVersion: f.version, approvalId: randomUUID() },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await database
            .selectFrom('identity.accounts')
            .select('state')
            .where('user_id', '=', f.userId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('deleted');
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE event_type='account.returned.v1' AND actor_user_id=${f.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });
    it('denies native revocation/expiry and a different original grant after the transition', async () => {
      const f = await createAccountReturnFixture(database),
        life = { userId: f.userId, productEpoch: 0 },
        body = payload(f.version);
      const revoked = (await controls().issue(life, randomUUID())).accountControlToken;
      await controls().revoke(life, revoked, randomUUID());
      expect((await post(revoked, body)).statusCode).toBe(401);
      const short = new AccountControlSessionService(
        new PostgresAccountControlSessionStore(database, 1),
        key,
      );
      const expired = (await short.issue(life, randomUUID())).accountControlToken;
      await sql`SELECT pg_sleep(1.1)`.execute(database);
      expect((await post(expired, body)).statusCode).toBe(401);
      const used = (await controls().issue(life, randomUUID())).accountControlToken,
        other = (await controls().issue(life, randomUUID())).accountControlToken;
      expect((await post(used, body)).statusCode).toBe(200);
      expect((await post(used, body)).statusCode).toBe(200);
      expect((await post(other, body)).statusCode).toBe(401);
      expect(
        await controls().authenticate({ bearerToken: used, audience: 'account_control' }),
      ).toBeUndefined();
    });
  },
);
