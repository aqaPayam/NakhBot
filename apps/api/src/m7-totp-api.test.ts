import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { M7TotpApiModule, type M7TotpApiOptions } from './m7-totp-api.js';
import { ApiExceptionFilter } from './app.js';

describe('authenticated authenticator HTTP boundary', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });
  const actor = { kind: 'user' as const, userId: randomUUID() };
  const invitationToken = `v1.mt.${'a'.repeat(43)}`;
  const headers = { authorization: 'Bearer first-factor-credential' };
  const privateSecret = 'private-provider-secret-code';
  async function start(
    overrides: Partial<M7TotpApiOptions> = {},
  ): Promise<{ options: M7TotpApiOptions; error: ReturnType<typeof vi.fn> }> {
    const options: M7TotpApiOptions = {
      authenticator: { authenticate: vi.fn(() => Promise.resolve(actor)) },
      enrollments: {
        begin: vi.fn(() =>
          Promise.resolve({
            enrollmentUri: `otpauth://totp/NakhBot:test?secret=${'A'.repeat(32)}&issuer=NakhBot&algorithm=SHA1&digits=6&period=30`,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
        ),
        confirm: vi.fn(() => Promise.resolve({ status: 'activated' as const, replayed: false })),
      },
      sessions: {
        issue: vi.fn(() =>
          Promise.resolve({
            adminSessionToken: `v1.as.${'a'.repeat(43)}`,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            mfaExpiresAt: new Date(Date.now() + 30000).toISOString(),
          }),
        ),
        revoke: vi.fn(() => Promise.resolve()),
      },
      telegramIdentity: vi.fn(() => Promise.resolve('123456789')),
      ...overrides,
    };
    const error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7TotpApiModule.register(options),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { options, error };
  }
  it('derives sign-in identity from the authenticated owner and rejects injected authority', async () => {
    const { options } = await start();
    const requestId = randomUUID();
    const payload = { actor, requestId, code: '123456' };
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(options.sessions.issue).toHaveBeenCalledWith({
      actor,
      requestId,
      telegramUserId: '123456789',
      proof: '123456',
    });
    for (const changed of [
      { ...payload, telegramUserId: '987654321' },
      { ...payload, roles: ['super_admin'] },
      { ...payload, verifiedAt: new Date().toISOString() },
      { ...payload, code: '１２３４５６' },
      { ...payload, code: '1234567' },
    ]) {
      expect(
        (
          await app!.inject({
            method: 'POST',
            url: '/v1/admin/auth/sessions',
            headers,
            payload: changed,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(options.sessions.issue).toHaveBeenCalledTimes(1);
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/v1/admin/auth/sessions',
          headers,
          payload: { ...payload, actor: { ...actor, userId: randomUUID() } },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app!.inject({ method: 'POST', url: '/v1/admin/auth/recovery', headers, payload }))
        .statusCode,
    ).toBe(404);
  });
  it('requires the user audience for enrollment and disables caches even on authentication failure', async () => {
    const { options } = await start({
      authenticator: { authenticate: () => Promise.resolve({ ...actor, kind: 'admin' }) },
    });
    for (const url of [
      '/v1/admin/auth/enrollment',
      '/v1/admin/auth/enrollment/confirm',
      '/v1/admin/auth/sessions',
    ]) {
      const response = await app!.inject({
        method: 'POST',
        url,
        headers,
        payload: { actor, requestId: randomUUID(), invitationToken, code: '123456' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
    }
    expect(vi.mocked(options.enrollments).begin.mock.calls).toHaveLength(0);
    expect(vi.mocked(options.enrollments).confirm.mock.calls).toHaveLength(0);
    expect(options.sessions.issue).not.toHaveBeenCalled();
  });
  it('discards provider errors before the global logger or response sees secret material', async () => {
    const { error } = await start({
      telegramIdentity: () => Promise.reject(new Error(privateSecret)),
    });
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers,
      payload: { actor, requestId: randomUUID(), code: '123456' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(privateSecret);
    expect(JSON.stringify(error.mock.calls)).not.toContain(privateSecret);
    const logged = error.mock.calls[0]?.[0] as { err: Error } | undefined;
    expect(logged?.err.message).toBe('error.m7.internal');
  });
  it('takes logout authority from the authenticated bearer, never a body token', async () => {
    const admin = { ...actor, kind: 'admin' as const };
    const { options } = await start({
      authenticator: { authenticate: () => Promise.resolve(admin) },
    });
    const requestId = randomUUID(),
      adminSessionToken = `v1.as.${'b'.repeat(43)}`;
    const response = await app!.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions/logout',
      headers: { authorization: `Bearer ${adminSessionToken}` },
      payload: { actor: admin, requestId },
    });
    expect(response.statusCode).toBe(200);
    expect(options.sessions.revoke).toHaveBeenCalledWith({
      actor: admin,
      requestId,
      adminSessionToken,
    });
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/v1/admin/auth/sessions/logout',
          headers,
          payload: { actor: admin, requestId, adminSessionToken },
        })
      ).statusCode,
    ).toBe(400);
  });
});
