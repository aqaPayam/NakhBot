import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GetReportMetadataPageHandler,
  GetReportEvidenceActionsHandler,
} from '@nakh/application';
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
  it('selects only report-scoped evidence actions and rejects forged actor or target claims', async () => {
    const selection = { actor, requestId: randomUUID(), adminActionToken: query.adminActionToken };
    const result = {
      reportId: randomUUID(),
      items: [
        {
          evidenceId: randomUUID(),
          evidenceType: 'message' as const,
          snapshotSchemaVersion: 1,
          revealActionToken: query.adminActionToken,
        },
      ],
    };
    const execute = vi.fn<GetReportEvidenceActionsHandler['execute']>(() =>
      Promise.resolve(result),
    );
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(actor) },
      metadata: { execute: () => Promise.resolve({ items: [] }) },
      evidenceActions: { execute },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/actions',
      headers,
      payload: selection,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(execute).toHaveBeenCalledWith(selection, actor);
    for (const payload of [
      { ...selection, actor: { ...actor, userId: randomUUID() } },
      { ...selection, reportId: randomUUID() },
      { ...selection, adminActionToken: 'malformed' },
    ])
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/v1/admin/reports/evidence/actions',
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(payload.actor.userId !== actor.userId ? 401 : 400);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('keeps evidence selection absent until the host supplies its capability', async () => {
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(actor) },
      metadata: { execute: () => Promise.resolve({ items: [] }) },
    });
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/reports/evidence/actions',
          headers,
          payload: { actor, requestId: randomUUID(), adminActionToken: query.adminActionToken },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('blocks private fields accidentally returned by evidence selection before logging or serialization', async () => {
    const privateValue = 'PRIVATE SNAPSHOT CONTENT';
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(actor) },
      metadata: { execute: () => Promise.resolve({ items: [] }) },
      evidenceActions: {
        execute: () =>
          Promise.resolve({
            reportId: randomUUID(),
            items: [
              {
                evidenceId: randomUUID(),
                evidenceType: 'message' as const,
                snapshotSchemaVersion: 1,
                content: privateValue,
              },
            ],
          }),
      },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/reports/evidence/actions',
      headers,
      payload: { actor, requestId: randomUUID(), adminActionToken: query.adminActionToken },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(privateValue);
    expect(JSON.stringify(error.mock.calls)).not.toContain(privateValue);
  });
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
