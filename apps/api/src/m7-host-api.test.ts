import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AesGcmReviewNoteProtector, ReportTokens, type OpaqueTokenStore } from '@nakh/application';
import { createDatabase, type NakhDatabase } from '@nakh/persistence-postgres';
import { M7HostApiModule } from './m7-host-api.js';
import { createM7HostOptions } from './m7-host-services.js';
import { ApiExceptionFilter } from './app.js';
describe('explicit shared M7 HTTP host', () => {
  let app: NestFastifyApplication | undefined, database: NakhDatabase | undefined;
  afterEach(async () => {
    await app?.close();
    await database?.destroy();
  });
  it('uses one verifier for every audience and leaves photo actions absent without a delivery revoker', async () => {
    database = createDatabase({
      url: 'postgresql://unused:unused@127.0.0.1:1/unused',
      poolMax: 1,
      statementTimeoutMs: 1000,
      lockTimeoutMs: 1000,
    });
    const tokens: OpaqueTokenStore = {
      get: () => Promise.resolve(undefined),
      putIfAbsent: () => Promise.resolve(true),
    };
    const authenticate = vi.fn(() => Promise.resolve(undefined));
    const options = createM7HostOptions({
      database,
      authenticator: { authenticate },
      reportTokens: new ReportTokens(tokens, Buffer.alloc(32, 1)),
      adminTokens: tokens,
      adminKey: Buffer.alloc(32, 2),
      safetyTokens: tokens,
      safetyKey: Buffer.alloc(32, 3),
      capabilities: {},
      reviewNotes: new AesGcmReviewNoteProtector('host-notes', 1, Buffer.alloc(32, 4)),
    });
    expect(Object.isFrozen(options)).toBe(true);
    expect(options.adminModeration.photos).toBeUndefined();
    expect(options.adminModeration.reportPhotoActions).toBeUndefined();
    app = await NestFactory.create<NestFastifyApplication>(
      M7HostApiModule.register(options),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error: vi.fn() } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer shared-host-credential' };
    const routes = [
      ['/v1/reports/prepare', 'user'],
      ['/v1/support/threads', 'user'],
      ['/v1/appeals/prepare', 'user'],
      ['/v1/admin/reports/metadata', 'admin'],
      ['/v1/admin/reports/queue/actions', 'admin'],
      ['/v1/admin/reports/evidence/access', 'admin'],
      ['/v1/admin/moderation/reviews/claim', 'admin'],
      ['/v1/admin/moderation/reviews/actions', 'admin'],
      ['/v1/admin/moderation/reports/account-actions', 'admin'],
      ['/v1/admin/safety/queue/actions', 'admin'],
      ['/v1/admin/support/metadata', 'admin'],
      ['/v1/admin/support/actions', 'admin'],
      ['/v1/admin/appeals/metadata', 'admin'],
      ['/v1/admin/support/reply/prepare', 'admin'],
      ['/v1/admin/appeals/review/accepted/prepare', 'admin'],
      ['/v1/admin/appeals/unban/prepare', 'admin'],
    ] as const;
    for (const [url, audience] of routes) {
      const response = await app.inject({ method: 'POST', url, headers, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(authenticate).toHaveBeenLastCalledWith({
        bearerToken: 'shared-host-credential',
        audience,
      });
    }
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation/photos/hide_photo/prepare',
      headers,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/moderation/reports/photo-actions',
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(authenticate).toHaveBeenCalledTimes(routes.length);
  });
});
