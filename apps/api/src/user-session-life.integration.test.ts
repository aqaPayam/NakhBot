import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OpenSupportThreadCommand } from '@nakh/contracts';
import { AesGcmReviewNoteProtector, ReportTokenFactory } from '@nakh/application';
import { createDatabase, runMigrations, type NakhDatabase } from '@nakh/persistence-postgres';
import {
  createRedisConnection,
  RedisOpaqueTokenStore,
  RedisUserOpaqueTokenStores,
} from '@nakh/queue-redis';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createDeletionFixture } from '../../../packages/persistence-postgres/src/testing/deletion-fixture.js';
import { createReportUser } from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { createM7SessionHostOptions } from './m7-session-host-services.js';
import { M7HostApiModule } from './m7-host-api.js';
import { ApiExceptionFilter } from './app.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(databaseUrl === undefined || redisUrl === undefined)(
  'actual native sessions and owned Redis HTTP composition',
  () => {
    const redis = createRedisConnection(redisUrl ?? 'redis://invalid');
    const prefix = `m8-http-${randomUUID()}`,
      key = Buffer.alloc(32, 103);
    let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    const apps: NestFastifyApplication[] = [];
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(databaseUrl!, 'm8_http_sessions');
      await runMigrations(isolated.url, resolve('migrations'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 15000,
      });
    });
    afterAll(async () => {
      for (const app of apps) await app.close();
      await redis.quit();
      await database?.destroy();
      await isolated?.destroy();
    });
    function composition(): ReturnType<typeof createM7SessionHostOptions> {
      const owned = new RedisUserOpaqueTokenStores(redis, prefix);
      return createM7SessionHostOptions({
        database,
        mfa: { verify: () => Promise.resolve(undefined) },
        reportTokens: new ReportTokenFactory(owned, key),
        adminTokens: new RedisOpaqueTokenStore(redis, `${prefix}:admin`),
        adminKey: key,
        safetyTokens: owned,
        safetyKey: key,
        capabilities: {},
        reviewNotes: new AesGcmReviewNoteProtector('m8-session-http', 1, key),
      });
    }
    async function server(
      host: ReturnType<typeof composition>['host'],
    ): Promise<NestFastifyApplication> {
      const app = await NestFactory.create<NestFastifyApplication>(
        M7HostApiModule.register(host),
        new FastifyAdapter(),
        { logger: false },
      );
      apps.push(app);
      app.useGlobalFilters(new ApiExceptionFilter({ error: vi.fn() } as unknown as Logger));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      return app;
    }
    function opening(userId: string): OpenSupportThreadCommand {
      const id = randomUUID();
      return {
        commandId: id,
        commandType: 'support.open-thread',
        schemaVersion: 1,
        actor: { kind: 'user', userId },
        requestId: id,
        idempotencyKey: id,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { text: 'Synthetic private HTTP support text' },
      };
    }
    function barrier(): { entered: Promise<void>; release: () => void; wait: () => Promise<void> } {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        entered,
        release,
        wait: async () => {
          enter();
          await waiting;
        },
      };
    }
    it('rejects an already authenticated delayed write after native revocation, while another grant remains usable', async () => {
      const c = composition(),
        userId = await createReportUser(database),
        life = { userId, productEpoch: 0 };
      const first = await c.userSessions.issue(life, randomUUID()),
        second = await c.userSessions.issue(life, randomUUID());
      const paused = barrier();
      const app = await server({
        ...c.host,
        support: {
          ...c.host.support,
          open: {
            execute: async (...args) => {
              await paused.wait();
              return c.host.support.open.execute(...args);
            },
          },
        },
      });
      const pending = app.inject({
        method: 'POST',
        url: '/v1/support/threads',
        headers: { authorization: `Bearer ${first.userSessionToken}` },
        payload: opening(userId),
      });
      // Fastify injection is thenable; start it before awaiting the deterministic barrier.
      const response = Promise.resolve(pending);
      await paused.entered;
      await c.userSessions.revoke(life, first.userSessionToken, randomUUID());
      paused.release();
      expect((await response).statusCode).toBe(409);
      expect(
        await database
          .selectFrom('support.support_threads')
          .select('id')
          .where('user_id', '=', userId)
          .execute(),
      ).toHaveLength(0);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/support/threads',
            headers: { authorization: `Bearer ${second.userSessionToken}` },
            payload: opening(userId),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/reports/reasons',
            headers: { authorization: `Bearer ${first.userSessionToken}` },
          })
        ).statusCode,
      ).toBe(401);
    });
    it('withholds delayed responses after revocation and prevents an admitted Root from receiving a delayed support write', async () => {
      const c = composition(),
        userId = await createReportUser(database),
        life = { userId, productEpoch: 0 };
      const issued = await c.userSessions.issue(life, randomUUID()),
        paused = barrier();
      const app = await server({
        ...c.host,
        reports: {
          ...c.host.reports,
          reasons: {
            execute: async () => {
              await paused.wait();
              return { items: [] };
            },
          },
        },
      });
      const response = Promise.resolve(
        app.inject({
          method: 'GET',
          url: '/v1/reports/reasons',
          headers: { authorization: `Bearer ${issued.userSessionToken}` },
        }),
      );
      await paused.entered;
      await c.userSessions.revoke(life, issued.userSessionToken, randomUUID());
      paused.release();
      expect((await response).statusCode).toBe(401);
      const rootPaused = barrier();
      const rootApp = await server({
        ...c.host,
        support: {
          ...c.host.support,
          open: {
            execute: async (...args) => {
              await rootPaused.wait();
              return c.host.support.open.execute(...args);
            },
          },
        },
      });
      let pending!: Promise<Awaited<ReturnType<NestFastifyApplication['inject']>>>;
      const deleted = await createDeletionFixture(database, async (subject) => {
        const credential = await c.userSessions.issue(
          { userId: subject, productEpoch: 0 },
          randomUUID(),
        );
        pending = Promise.resolve(
          rootApp.inject({
            method: 'POST',
            url: '/v1/support/threads',
            headers: { authorization: `Bearer ${credential.userSessionToken}` },
            payload: opening(subject),
          }),
        );
        await rootPaused.entered;
      });
      rootPaused.release();
      expect((await pending).statusCode).toBe(409);
      expect(
        await database
          .selectFrom('support.support_threads')
          .select('id')
          .where('user_id', '=', deleted.userId)
          .execute(),
      ).toHaveLength(0);
    });
    it('isolates report references by owner and original life in the actual owned Redis factory', async () => {
      const owned = new RedisUserOpaqueTokenStores(redis, prefix),
        refs = new ReportTokenFactory(owned, key);
      const userId = randomUUID(),
        life = { userId, productEpoch: 0 };
      const source = { kind: 'received_like' as const, referenceId: randomUUID() };
      const token = await refs.forLife(life).issueSource(userId, source);
      expect(await refs.forLife(life).resolveSource(token.token, userId)).toEqual(source);
      expect(
        await refs.forLife({ userId, productEpoch: 1 }).resolveSource(token.token, userId),
      ).toBeUndefined();
      expect(
        await refs
          .forLife({ userId: randomUUID(), productEpoch: 0 })
          .resolveSource(token.token, userId),
      ).toBeUndefined();
    });
  },
);
