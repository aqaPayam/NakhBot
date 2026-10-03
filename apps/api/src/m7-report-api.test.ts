import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import type { GetReportReasonsHandler } from '@nakh/application';
import { ApiExceptionFilter } from './app.js';
import { M7ReportApiModule, type M7ReportApiOptions } from './m7-report-api.js';

const user = { kind: 'user' as const, userId: randomUUID() };
describe('authenticated M7 report HTTP routes', () => {
  let app: NestFastifyApplication | undefined;
  const error = vi.fn();
  afterEach(async () => {
    await app?.close();
    app = undefined;
    error.mockClear();
  });
  async function start(options: M7ReportApiOptions): Promise<NestFastifyApplication> {
    app = await NestFactory.create<NestFastifyApplication>(
      M7ReportApiModule.register(options),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }
  it('serves only the authorized reason catalog and prevents response caching', async () => {
    const execute = vi.fn<GetReportReasonsHandler['execute']>(() =>
      Promise.resolve({ items: [{ code: 'harassment', labelKey: 'report.reason.harassment' }] }),
    );
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(user) },
      reasons: { execute },
    });
    const response = await server.inject({
      method: 'GET',
      url: '/v1/reports/reasons',
      headers: { authorization: 'Bearer privatecredential' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ code: 'harassment', labelKey: 'report.reason.harassment' }],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(execute.mock.calls[0]?.[0].actor).toEqual(user);
    expect(execute.mock.calls[0]?.[0].requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(execute.mock.calls[0]?.[1]).toEqual(user);
    expect(response.body).not.toContain(user.userId);
  });
  it('denies missing credentials and admin identities before loading reasons', async () => {
    const execute = vi.fn(() => Promise.resolve({ items: [] }));
    const server = await start({
      authenticator: {
        authenticate: () => Promise.resolve({ kind: 'admin', userId: randomUUID() }),
      },
      reasons: { execute },
    });
    for (const headers of [{}, { authorization: 'Bearer privatecredential' }])
      expect(
        (await server.inject({ method: 'GET', url: '/v1/reports/reasons', headers })).statusCode,
      ).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
  it('sanitizes domain failures and unexpected failures before HTTP output or logging', async () => {
    const privateText = 'PRIVATE REPORT SECRET';
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new ApplicationError('report_unavailable', privateText, 409, { text: privateText }),
      )
      .mockRejectedValueOnce(new Error(privateText));
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(user) },
      reasons: { execute },
    });
    for (const status of [409, 500]) {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/reports/reasons',
        headers: {
          authorization: 'Bearer privatecredential',
          'x-request-id': privateText,
        },
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain(privateText);
      expect(response.json()).not.toHaveProperty('errors');
      expect(response.json<{ requestId: string }>().requestId).toMatch(/^[0-9a-f-]{36}$/u);
    }
    expect(JSON.stringify(error.mock.calls)).not.toContain(privateText);
  });
});
