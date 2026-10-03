import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import type {
  GetReportReasonsHandler,
  PrepareSingleReportEvidenceHandler,
  SubmitSingleEvidenceReportHandler,
} from '@nakh/application';
import type { SubmitReportCommand } from '@nakh/contracts';
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
  it('prepares opaque evidence with authenticated actor binding and rejects raw references or extra fields', async () => {
    const execute = vi.fn<PrepareSingleReportEvidenceHandler['execute']>(() =>
      Promise.resolve({
        evidenceIntentToken: `v1.ri.${'a'.repeat(16)}.${'b'.repeat(16)}`,
        evidenceTypes: ['message'],
        expiresAt: '2026-10-04T00:00:00.000Z',
      }),
    );
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(user) },
      reasons: { execute: () => Promise.resolve({ items: [] }) },
      prepare: { execute },
    });
    const query = {
      actor: user,
      requestId: randomUUID(),
      sourceActionToken: `v1.rs.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      requestedEvidenceTypes: ['message'],
    };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/reports/prepare',
      headers: { authorization: 'Bearer privatecredential' },
      payload: query,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(await execute.mock.results[0]!.value);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(execute).toHaveBeenCalledWith(query, user);
    expect(response.body).not.toContain(user.userId);
    for (const [payload, status] of [
      [{ ...query, actor: { ...user, userId: randomUUID() } }, 401],
      [{ ...query, messageId: randomUUID() }, 400],
      [{ ...query, sourceActionToken: randomUUID() }, 400],
      [{ ...query, requestedEvidenceTypes: ['unknown'] }, 400],
    ] as const)
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/v1/reports/prepare',
            headers: { authorization: 'Bearer privatecredential' },
            payload,
          })
        ).statusCode,
      ).toBe(status);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not register preparation when its authorized application port is absent', async () => {
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(user) },
      reasons: { execute: () => Promise.resolve({ items: [] }) },
    });
    expect(
      (await server.inject({ method: 'POST', url: '/v1/reports/prepare', payload: {} })).statusCode,
    ).toBe(404);
  });
  it('preserves submission command identity and releases only the safe receipt across retries', async () => {
    const receipt = {
      reportId: randomUUID(),
      status: 'pending_review' as const,
      submittedAt: new Date().toISOString(),
      replayed: false,
    };
    const execute = vi
      .fn<SubmitSingleEvidenceReportHandler['execute']>()
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce({ ...receipt, replayed: true });
    const server = await start({
      authenticator: { authenticate: () => Promise.resolve(user) },
      reasons: { execute: () => Promise.resolve({ items: [] }) },
      submit: { execute },
    });
    const command: SubmitReportCommand = {
      commandType: 'moderation.submit-report',
      schemaVersion: 1,
      actor: user,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        reasonCode: 'harassment',
        evidenceIntentToken: `v1.ri.${'a'.repeat(16)}.${'b'.repeat(16)}`,
        text: 'Private report complaint',
      },
    };
    for (const replayed of [false, true]) {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: { authorization: 'Bearer privatecredential' },
        payload: command,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ ...receipt, replayed });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(command.data.text!);
      expect(response.body).not.toContain(user.userId);
    }
    expect(execute).toHaveBeenNthCalledWith(1, command, user);
    expect(execute).toHaveBeenNthCalledWith(2, command, user);
    const forged = await server.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { authorization: 'Bearer privatecredential' },
      payload: { ...command, data: { ...command.data, targetUserId: randomUUID() } },
    });
    expect(forged.statusCode).toBe(400);
    expect(execute).toHaveBeenCalledTimes(2);
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
