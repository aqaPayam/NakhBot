import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrepareAppealHandler, SubmitAppealHandler } from '@nakh/application';
import { M7AppealApiModule } from './m7-appeal-api.js';
import { ApiExceptionFilter } from './app.js';
describe('actor-bound appeal HTTP', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });
  it('prepares only for verified identity and rejects raw ban IDs before submission', async () => {
    const actor = { kind: 'user' as const, userId: randomUUID() },
      token = `v1.bn.${'a'.repeat(16)}.${'b'.repeat(16)}`;
    const prepare = vi.fn<PrepareAppealHandler['execute']>(() => Promise.resolve(token));
    const submit = vi.fn<SubmitAppealHandler['execute']>(() =>
      Promise.resolve({
        appealId: randomUUID(),
        status: 'submitted',
        version: 1,
        changedAt: new Date().toISOString(),
        replayed: false,
      }),
    );
    app = await NestFactory.create<NestFastifyApplication>(
      M7AppealApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(actor) },
        prepare: { execute: prepare },
        submit: { execute: submit },
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error: vi.fn() } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer appeal-user-credential' },
      commandId = randomUUID(),
      requestId = randomUUID();
    const prepared = await app.inject({
      method: 'POST',
      url: '/v1/appeals/prepare',
      headers,
      payload: { actor, commandId, requestId },
    });
    expect(prepared.json()).toEqual({ banActionToken: token });
    expect(prepare).toHaveBeenCalledWith(actor.userId, commandId);
    const payload = {
      actor,
      commandId,
      requestId,
      commandType: 'moderation.submit-appeal',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
      locale: 'en',
      data: { banActionToken: token, text: 'Private appeal text' },
    };
    const response = await app.inject({ method: 'POST', url: '/v1/appeals', headers, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('appealId');
    expect(response.body).not.toContain(payload.data.text);
    expect(response.headers['cache-control']).toBe('no-store');
    const raw = await app.inject({
      method: 'POST',
      url: '/v1/appeals',
      headers,
      payload: { ...payload, data: { ...payload.data, banHistoryId: randomUUID() } },
    });
    expect(raw.statusCode).toBe(400);
    const spoof = await app.inject({
      method: 'POST',
      url: '/v1/appeals/prepare',
      headers,
      payload: { actor: { ...actor, userId: randomUUID() }, commandId, requestId },
    });
    expect(spoof.statusCode).toBe(401);
    expect(prepare).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });
});
