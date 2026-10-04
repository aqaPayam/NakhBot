import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenSupportThreadHandler, SendSupportMessageHandler } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { M7SupportApiModule } from './m7-support-api.js';
import { ApiExceptionFilter } from './app.js';

describe('authenticated opaque support HTTP', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });
  it('binds verified identity, projects opaque receipts, and sanitizes private failures', async () => {
    const actor = { kind: 'user' as const, userId: randomUUID() },
      threadId = randomUUID();
    const privateText = 'Private support request';
    const result = {
      supportThreadId: threadId,
      supportActionToken: `v1.sp.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      status: 'open' as const,
      unansweredUserMessages: 1,
      version: 1,
      changedAt: new Date().toISOString(),
      replayed: false,
    };
    const open = vi.fn<OpenSupportThreadHandler['execute']>(() => Promise.resolve(result));
    const send = vi.fn<SendSupportMessageHandler['execute']>(() =>
      Promise.reject(new ApplicationError('forbidden', privateText, 403, { text: privateText })),
    );
    const error = vi.fn();
    app = await NestFactory.create<NestFastifyApplication>(
      M7SupportApiModule.register({
        authenticator: {
          authenticate: ({ bearerToken }) =>
            Promise.resolve(bearerToken === 'support-user-credential' ? actor : undefined),
        },
        open: { execute: open },
        send: { execute: send },
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer support-user-credential' };
    const base = {
      actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
    };
    const payload = { ...base, commandType: 'support.open-thread', data: { text: privateText } };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/support/threads',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('supportThreadId');
    expect(response.body).not.toContain(threadId);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(open).toHaveBeenCalledWith(payload);
    const spoof = await app.inject({
      method: 'POST',
      url: '/v1/support/threads',
      headers,
      payload: { ...payload, actor: { ...actor, userId: randomUUID() } },
    });
    expect(spoof.statusCode).toBe(401);
    expect(open).toHaveBeenCalledOnce();
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/support/messages',
      headers,
      payload: {
        ...base,
        commandType: 'support.send-message',
        data: {
          text: privateText,
          supportActionToken: result.supportActionToken,
          expectedVersion: 1,
        },
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain(privateText);
    expect(error).not.toHaveBeenCalled();
  });
});
