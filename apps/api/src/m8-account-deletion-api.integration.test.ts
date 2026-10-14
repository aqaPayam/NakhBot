import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@nakh/config';
import {
  createDatabase,
  runMigrations,
  createPostgresAccountControls,
  createPostgresUserSessions,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createReportUser } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { createAccountDeletionApi } from './m8-account-deletion-api.js';
import { ApiExceptionFilter } from './app.js';
const url = process.env.NAKH_TEST_DATABASE_URL,
  key = Buffer.alloc(32, 111);
describe.skipIf(url === undefined)(
  'production own deletion HTTP and native limited authority',
  () => {
    let database: NakhDatabase,
      app: NestFastifyApplication,
      isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm8_delete_api');
      await runMigrations(isolated.url, resolve('migrations'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 15000,
        lockTimeoutMs: 10000,
      });
      vi.stubEnv('M8_CONTROL_KEY', key.toString('base64url'));
      vi.stubEnv('M8_CONFIRMATION_KEY', Buffer.alloc(32, 112).toString('base64url'));
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
        NAKH_MEDIA_CDN_HOST: 'media.example.com',
        NAKH_MEDIA_SIGNING_KEY_REF: 'NAKH_MEDIA_SIGNING_KEY',
        NAKH_DELETION_API_ENABLED: 'true',
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'a'.repeat(64),
        NAKH_ACCOUNT_CONTROL_KEY_REF: 'M8_CONTROL_KEY',
        NAKH_DELETION_CONFIRMATION_KEY_REF: 'M8_CONFIRMATION_KEY',
      });
      // The configured readiness assertion is synthetic; this test does not certify an actual producer drain.
      app = await NestFactory.create<NestFastifyApplication>(
        createAccountDeletionApi(config, database)[0]!,
        new FastifyAdapter(),
        { logger: false },
      );
      app.useGlobalFilters(new ApiExceptionFilter(pino({ enabled: false })));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });
    afterAll(async () => {
      await app?.close();
      await database?.destroy();
      await isolated?.destroy();
      vi.unstubAllEnvs();
    });
    const controls = (): ReturnType<typeof createPostgresAccountControls> =>
      createPostgresAccountControls(database, key);
    async function fixture(): Promise<{
      life: { userId: string; productEpoch: number };
      token: string;
      headers: { authorization: string };
    }> {
      const userId = await createReportUser(database),
        life = { userId, productEpoch: 0 };
      const token = (await controls().issue(life, randomUUID())).accountControlToken;
      return { life, token, headers: { authorization: 'Bearer ' + token } };
    }
    it('admits one deletion across twenty HTTP retries and keeps only own minimal status after tombstone', async () => {
      const f = await fixture(),
        products = createPostgresUserSessions(database, key),
        normal = (await products.issue(f.life, randomUUID())).userSessionToken;
      const prepared = await app.inject({
        method: 'POST',
        url: '/v1/account/deletion/prepare',
        headers: f.headers,
        payload: { requestId: randomUUID(), expectedAccountVersion: 1 },
      });
      expect(prepared.statusCode).toBe(200);
      const data = prepared.json<{ confirmationToken: string }>(),
        payload = {
          commandId: randomUUID(),
          commandType: 'account.delete',
          schemaVersion: 1,
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { confirmationToken: data.confirmationToken, expectedAccountVersion: 1 },
        };
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          app.inject({
            method: 'POST',
            url: '/v1/account/deletion/confirm',
            headers: f.headers,
            payload,
          }),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual(Array.from({ length: 20 }, () => 200));
      expect(
        results.filter((r) => r.json<{ replayed: boolean }>().replayed === false),
      ).toHaveLength(1);
      expect(
        await products.authenticate({ bearerToken: normal, audience: 'user' }),
      ).toBeUndefined();
      const status = await app.inject({
        method: 'POST',
        url: '/v1/account/deletion/status',
        headers: f.headers,
        payload: { requestId: randomUUID() },
      });
      expect(status.statusCode).toBe(200);
      expect(Object.keys(status.json()).sort()).toEqual([
        'completedAt',
        'phase',
        'requestedAt',
        'returnDecision',
      ]);
      expect(status.headers['cache-control']).toBe('no-store');
      expect(status.body).not.toContain(f.life.userId);
      expect(
        (
          await sql<{
            id: string;
          }>`SELECT id FROM identity.account_deletion_records WHERE user_id=${f.life.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toHaveLength(1);
      await controls().revoke(f.life, f.token, randomUUID());
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/account/deletion/status',
            headers: f.headers,
            payload: { requestId: randomUUID() },
          })
        ).statusCode,
      ).toBe(401);
    });
    it('cancels the exact native confirmation idempotently without tombstoning the account', async () => {
      const f = await fixture(),
        proof = await app.inject({
          method: 'POST',
          url: '/v1/account/deletion/prepare',
          headers: f.headers,
          payload: { requestId: randomUUID(), expectedAccountVersion: 1 },
        });
      expect(proof.statusCode).toBe(200);
      const payload = {
        commandId: randomUUID(),
        commandType: 'account.cancel-deletion',
        schemaVersion: 1,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          confirmationToken: proof.json<{ confirmationToken: string }>().confirmationToken,
          expectedAccountVersion: 1,
        },
      };
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          app.inject({
            method: 'POST',
            url: '/v1/account/deletion/cancel',
            headers: f.headers,
            payload,
          }),
        ),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(results.filter((r) => !r.json<{ replayed: boolean }>().replayed)).toHaveLength(1);
      const account = await database
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', f.life.userId)
        .executeTakeFirstOrThrow();
      expect(account.state).toBe('active');
    });
    it('rejects ordinary product credentials and foreign confirmation without revealing another account', async () => {
      const f = await fixture(),
        other = await fixture(),
        normal = (await createPostgresUserSessions(database, key).issue(f.life, randomUUID()))
          .userSessionToken;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/account/deletion/prepare',
            headers: { authorization: 'Bearer ' + normal },
            payload: { requestId: randomUUID(), expectedAccountVersion: 1 },
          })
        ).statusCode,
      ).toBe(401);
      const proof = await app.inject({
        method: 'POST',
        url: '/v1/account/deletion/prepare',
        headers: f.headers,
        payload: { requestId: randomUUID(), expectedAccountVersion: 1 },
      });
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/account/deletion/confirm',
        headers: other.headers,
        payload: {
          commandId: randomUUID(),
          commandType: 'account.delete',
          schemaVersion: 1,
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: {
            confirmationToken: proof.json<{ confirmationToken: string }>().confirmationToken,
            expectedAccountVersion: 1,
          },
        },
      });
      expect(denied.statusCode).toBe(409);
      expect(denied.body).not.toContain(f.life.userId);
      expect(denied.body).not.toContain(
        proof.json<{ confirmationToken: string }>().confirmationToken,
      );
    });
  },
);
