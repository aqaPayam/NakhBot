import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  AccountReturnActor,
  AccountReturnStore,
  AccountControlSessionService,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { M8AccountReturnApiModule } from './m8-account-return-api.js';
import { ApiExceptionFilter } from './app.js';

describe('original-grant own Return HTTP boundary', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });
  async function fixture(): Promise<{
    actor: AccountReturnActor;
    controls: { authenticateReturn: Mock<AccountControlSessionService['authenticateReturn']> };
    store: { return: Mock<AccountReturnStore['return']> };
    app: NestFastifyApplication;
    headers: { authorization: string };
    payload: Record<string, unknown>;
  }> {
    const actor: AccountReturnActor = {
      kind: 'user',
      scope: 'account_return',
      userId: randomUUID(),
      productEpoch: 0,
      controlGrantId: randomUUID(),
    };
    const controls = {
      authenticateReturn: vi.fn<AccountControlSessionService['authenticateReturn']>(() =>
        Promise.resolve(actor),
      ),
    };
    const store = {
      return: vi.fn<AccountReturnStore['return']>(() =>
        Promise.resolve({ returned: true, accountVersion: 3, replayed: false }),
      ),
    };
    app = await NestFactory.create<NestFastifyApplication>(
      M8AccountReturnApiModule.register({
        controls,
        store: (bound) => {
          expect(bound).toEqual(actor);
          expect(Object.isFrozen(bound)).toBe(true);
          return store;
        },
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter(pino({ enabled: false })));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return {
      actor,
      controls,
      store,
      app,
      headers: { authorization: 'Bearer limited-original-control' },
      payload: {
        commandId: randomUUID(),
        commandType: 'account.return',
        schemaVersion: 1,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { expectedAccountVersion: 2 },
      },
    };
  }
  it('binds only Return scope, rechecks original grant and returns an uncached credential-free receipt', async () => {
    const f = await fixture();
    const r = await f.app.inject({
      method: 'POST',
      url: '/v1/account/return/confirm',
      headers: f.headers,
      payload: f.payload,
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.pragma).toBe('no-cache');
    expect(r.json()).toEqual({ returned: true, accountVersion: 3, replayed: false });
    expect(r.body).not.toContain(f.actor.userId);
    expect(f.store.return).toHaveBeenCalledWith({
      ...f.payload,
      actor: { kind: 'user', userId: f.actor.userId },
    });
    expect(f.controls.authenticateReturn).toHaveBeenCalledTimes(2);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/account/return/issue',
          headers: f.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
  it('rejects actor, epoch, approval, Root, channel and confirmation selectors before mutation', async () => {
    const f = await fixture();
    for (const extra of [
      { actor: { kind: 'user', userId: randomUUID() } },
      { channelContext: {} },
      { productEpoch: 1 },
      { data: { expectedAccountVersion: 2147483648 } },
      { data: { expectedAccountVersion: 0 } },
      { approvalId: randomUUID() },
      { data: { expectedAccountVersion: 2, deletionRecordId: randomUUID() } },
      { data: { expectedAccountVersion: 2, confirmationToken: 'x'.repeat(43) } },
    ]) {
      const r = await f.app.inject({
        method: 'POST',
        url: '/v1/account/return/confirm',
        headers: f.headers,
        payload: { ...f.payload, ...extra },
      });
      expect(r.statusCode).toBe(400);
    }
    expect(f.store.return).not.toHaveBeenCalled();
    f.controls.authenticateReturn.mockResolvedValue(undefined);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/account/return/confirm',
          headers: f.headers,
          payload: f.payload,
        })
      ).statusCode,
    ).toBe(401);
  });
  it('denies changed owner, epoch, grant, scope or missing authority after a native wait', async () => {
    const f = await fixture();
    for (const current of [
      undefined,
      { ...f.actor, userId: randomUUID() },
      { ...f.actor, productEpoch: 1 },
      { ...f.actor, controlGrantId: randomUUID() },
      { ...f.actor, scope: 'account_control' },
    ]) {
      f.controls.authenticateReturn
        .mockReset()
        .mockResolvedValueOnce(f.actor)
        .mockResolvedValueOnce(current as AccountReturnActor | undefined);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/v1/account/return/confirm',
            headers: f.headers,
            payload: f.payload,
          })
        ).statusCode,
      ).toBe(401);
    }
  });
  it('sanitizes native failures and rejects extra response data before serialization', async () => {
    const f = await fixture(),
      privateText = 'private-root-proof-and-credentials';
    f.store.return.mockRejectedValueOnce(
      new ApplicationError('conflict', privateText, 409, { privateText }),
    );
    const r = await f.app.inject({
      method: 'POST',
      url: '/v1/account/return/confirm',
      headers: f.headers,
      payload: f.payload,
    });
    expect(r.statusCode).toBe(409);
    expect(r.body).not.toContain(privateText);
    f.store.return.mockResolvedValueOnce({
      returned: true,
      accountVersion: 3,
      replayed: false,
      privateText,
    } as Awaited<ReturnType<AccountReturnStore['return']>>);
    const unsafe = await f.app.inject({
      method: 'POST',
      url: '/v1/account/return/confirm',
      headers: f.headers,
      payload: f.payload,
    });
    expect(unsafe.statusCode).toBe(500);
    expect(unsafe.body).not.toContain(privateText);
  });
});
