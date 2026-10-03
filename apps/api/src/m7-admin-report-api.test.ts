import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GetReportMetadataPageHandler } from '@nakh/application';
import { ApiExceptionFilter } from './app.js';
import { M7AdminReportApiModule, type M7AdminReportApiOptions } from './m7-admin-report-api.js';

const actor = { kind: 'admin' as const, userId: randomUUID() },
  headers = { authorization: 'Bearer metadata-admin-credential' };
describe('signed authenticated admin report metadata HTTP', () => {
  let app: NestFastifyApplication | undefined;
  const error = vi.fn();
  afterEach(async () => {
    await app?.close();
    app = undefined;
    error.mockClear();
  });
  async function start(options: M7AdminReportApiOptions): Promise<NestFastifyApplication> {
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminReportApiModule.register(options),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }
  const query = {
    actor,
    requestId: randomUUID(),
    adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    limit: 10,
  };
  it('passes only a bounded signed query to metadata and returns non-cacheable content-free rows', async () => {
    const result = {
      items: [
        {
          reportId: randomUUID(),
          reasonCode: 'harassment',
          evidenceTypes: ['message' as const],
          status: 'pending_review' as const,
          priority: 'normal' as const,
          submittedAt: new Date().toISOString(),
          priorReportCount: 0,
          version: 1,
        },
      ],
    };
    const execute = vi.fn<GetReportMetadataPageHandler['execute']>(() => Promise.resolve(result));
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(actor) },
      metadata: { execute },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/metadata',
      headers,
      payload: query,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(execute).toHaveBeenCalledWith(query, actor);
    expect(response.body).not.toContain(actor.userId);
    for (const payload of [
      { ...query, limit: 51 },
      { ...query, reporterUserId: randomUUID() },
      { ...query, cursor: 'invalid' },
    ])
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/v1/admin/reports/metadata',
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/reports/metadata',
          headers,
          payload: { ...query, actor: { ...actor, userId: randomUUID() } },
        })
      ).statusCode,
    ).toBe(401);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects user credentials before querying metadata', async () => {
    const execute = vi.fn<GetReportMetadataPageHandler['execute']>(() =>
      Promise.resolve({ items: [] }),
    );
    const server = await start({
      authenticator: {
        authenticate: () => Promise.resolve({ kind: 'user', userId: actor.userId }),
      },
      metadata: { execute },
    });
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/reports/metadata',
          headers,
          payload: query,
        })
      ).statusCode,
    ).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects accidental identity or content disclosure before serialization or logging', async () => {
    const privateValue = 'PRIVATE REPORTER AND CHAT';
    const row = {
      reportId: randomUUID(),
      reasonCode: 'harassment',
      evidenceTypes: ['message' as const],
      status: 'pending_review' as const,
      priority: 'normal' as const,
      submittedAt: new Date().toISOString(),
      priorReportCount: 0,
      version: 1,
      reporterIdentity: privateValue,
    };
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(actor) },
      metadata: { execute: () => Promise.resolve({ items: [row] }) },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/metadata',
      headers,
      payload: query,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(privateValue);
    expect(JSON.stringify(error.mock.calls)).not.toContain(privateValue);
  });
});
