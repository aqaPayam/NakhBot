import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { M7OperationalHealthApiModule } from './m7-operational-health-api.js';
import { ApiExceptionFilter } from './app.js';
const actor = { kind: 'admin' as const, userId: randomUUID() };
const token = `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const sample = {
  sampledAt: new Date().toISOString(),
  oldestPendingReportAgeSeconds: 0,
  oldestInReviewAgeSeconds: 0,
  thresholdMismatchCount: 0,
  adminLogMismatchCount: 0,
  snapshotIntegrityFailureCount: 0,
  supportLimitMismatchCount: 0,
  appealUniquenessMismatchCount: 0,
};
describe('operational health HTTP session boundary', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });
  it('validates input, rechecks sessions after awaited reads and sanitizes all failures', async () => {
    let identity: typeof actor | undefined = actor;
    const authenticate = vi.fn(() => Promise.resolve(identity));
    const prepare = vi.fn(() => Promise.resolve({ adminActionToken: token }));
    const get = vi.fn(() => Promise.resolve({ ...sample }));
    const error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7OperationalHealthApiModule.register({
        authenticator: { authenticate },
        prepare: { execute: prepare },
        get: { execute: get },
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer health-admin-credential' },
      payload = { actor, requestId: randomUUID(), adminActionToken: token },
      url = '/v1/admin/moderation/operational-health';
    const prepared = await app.inject({
      method: 'POST',
      url: `${url}/prepare`,
      headers,
      payload: { actor, requestId: randomUUID() },
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toEqual({ adminActionToken: token });
    const response = await app.inject({ method: 'POST', url, headers, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(sample);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    for (const invalid of [
      { ...payload, extra: 'private' },
      { ...payload, adminActionToken: 'raw-id' },
    ])
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: invalid })).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, actor: { ...actor, userId: randomUUID() } },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect(get).toHaveBeenCalledOnce();
    get.mockImplementation(() => {
      identity = undefined;
      return Promise.resolve({ ...sample });
    });
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(401);
    identity = actor;
    get.mockImplementation(() => {
      identity = { ...actor, userId: randomUUID() };
      return Promise.resolve({ ...sample });
    });
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(401);
    identity = actor;
    get.mockImplementation(() => Promise.reject(new Error('private SQL and identity')));
    const failed = await app.inject({ method: 'POST', url, headers, payload });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('private SQL');
    expect(JSON.stringify(error.mock.calls)).not.toContain('private SQL');
    prepare.mockImplementation(() => {
      identity = undefined;
      return Promise.resolve({ adminActionToken: token });
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/prepare`,
          headers,
          payload: { actor, requestId: randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('has no default routes without explicit trusted composition', async () => {
    @Module({})
    class Empty {}
    app = await NestFactory.create<NestFastifyApplication>(Empty, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/moderation/operational-health',
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});
