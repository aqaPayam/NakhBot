import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '@nakh/config';
import { createDatabase, runMigrations, type NakhDatabase } from '@nakh/persistence-postgres';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { ApiExceptionFilter, ApiModule } from './app.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('ordinary hosted API baseline surface', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    database: NakhDatabase,
    app: NestFastifyApplication;
  const routes: string[] = [];
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_hosted_api');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 2,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 5000,
    });
    const config = parseConfig({
      NAKH_ENV: 'staging',
      NAKH_SERVICE_NAME: 'api',
      NAKH_RELEASE: 'a'.repeat(40),
      NAKH_DATABASE_URL: isolated.url,
      NAKH_REDIS_URL: 'redis://unused',
      NAKH_TELEGRAM_BOT_TOKEN_REF: 'UNUSED_BOT',
      NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
      NAKH_R2_ENDPOINT: 'https://r2.invalid',
      NAKH_R2_BUCKET: 'fixture',
      NAKH_R2_ACCESS_KEY_REF: 'UNUSED_ACCESS',
      NAKH_R2_SECRET_KEY_REF: 'UNUSED_SECRET',
      NAKH_MEDIA_CDN_HOST: 'media.invalid',
      NAKH_MEDIA_SIGNING_KEY_REF: 'UNUSED_SIGNING',
    });
    const adapter = new FastifyAdapter();
    adapter.getInstance().addHook('onRoute', (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method])
        if (method !== 'HEAD') routes.push(method + ' ' + route.url);
    });
    app = await NestFactory.create<NestFastifyApplication>(
      ApiModule.register(config, pino({ level: 'silent' })),
      adapter,
      { logger: false },
    );
    app.useGlobalFilters(app.get(ApiExceptionFilter));
    await app.init();
    await adapter.getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
    await database?.destroy();
    await isolated?.destroy();
  });
  it('exposes only the baseline host routes and rejects a valid sample write on staging before any native effect', async () => {
    expect(routes.sort()).toEqual([
      'GET /health/live',
      'GET /health/ready',
      'POST /v1/internal/foundation/sample-effects',
    ]);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    const command = {
      commandId: randomUUID(),
      commandType: 'platform.create-sample-effect',
      schemaVersion: 1,
      actor: { userId: randomUUID(), kind: 'system' },
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { name: 'synthetic-hosted-route-probe' },
    };
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/internal/foundation/sample-effects',
            payload: command,
          })
        ).statusCode,
      ).toBe(404);
    expect(
      await database
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('scope', '=', 'platform.create-sample-effect')
        .execute(),
    ).toHaveLength(0);
    expect(await database.selectFrom('platform.outbox_events').select('id').execute()).toHaveLength(
      0,
    );
  });
});
