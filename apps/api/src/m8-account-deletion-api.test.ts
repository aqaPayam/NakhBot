import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  AccountControlActor,
  AccountDeletionStore,
  AccountControlSessionService,
} from '@nakh/application';
import type { PreparedAccountDeletion, AccountDeletionStatus } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import { M8AccountDeletionApiModule } from './m8-account-deletion-api.js';
import { ApiExceptionFilter } from './app.js';

describe('limited own deletion HTTP boundary', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });
  async function fixture(): Promise<{
    actor: AccountControlActor;
    controls: { authenticate: Mock<AccountControlSessionService['authenticate']> };
    store: { [K in keyof AccountDeletionStore]: Mock<AccountDeletionStore[K]> };
    factory: Mock<(actor: AccountControlActor) => AccountDeletionStore>;
    headers: { authorization: string };
    query: { requestId: string; expectedAccountVersion: number };
    prepared: PreparedAccountDeletion;
    status: AccountDeletionStatus;
    app: NestFastifyApplication;
  }> {
    const actor: AccountControlActor = {
      kind: 'user',
      scope: 'account_control',
      userId: randomUUID(),
      productEpoch: 0,
      controlGrantId: randomUUID(),
    };
    const controls = {
      authenticate: vi.fn(() => Promise.resolve<AccountControlActor | undefined>(actor)),
    };
    const prepared = {
      confirmationToken: 'a'.repeat(43),
      expectedAccountVersion: 1,
      expiresAt: new Date().toISOString(),
    };
    const status = {
      phase: 'shared_closure' as const,
      requestedAt: new Date().toISOString(),
      completedAt: null,
      returnDecision: 'purge_pending' as const,
    };
    const store = {
      prepare: vi.fn<AccountDeletionStore['prepare']>(() => Promise.resolve(prepared)),
      request: vi.fn<AccountDeletionStore['request']>(() =>
        Promise.resolve({ status, accountVersion: 2, replayed: false }),
      ),
      cancel: vi.fn<AccountDeletionStore['cancel']>(() =>
        Promise.resolve({ cancelled: true, replayed: false }),
      ),
      status: vi.fn<AccountDeletionStore['status']>(() => Promise.resolve(status)),
    };
    const factory = vi.fn((verified: AccountControlActor) => {
      expect(verified).toEqual(actor);
      return store;
    });
    app = await NestFactory.create<NestFastifyApplication>(
      M8AccountDeletionApiModule.register({ controls, store: factory }),
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter(pino({ enabled: false })));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer limited-control-credential' };
    const query = { requestId: randomUUID(), expectedAccountVersion: 1 };
    return { actor, controls, store, factory, headers, query, prepared, status, app };
  }
  it('injects only verified identity, freezes the original grant and serves all four no-store actions', async () => {
    const f = await fixture();
    const base = {
      commandId: randomUUID(),
      schemaVersion: 1,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { confirmationToken: f.prepared.confirmationToken, expectedAccountVersion: 1 },
    };
    for (const [route, payload] of [
      ['prepare', f.query],
      ['confirm', { ...base, commandType: 'account.delete' }],
      ['cancel', { ...base, commandType: 'account.cancel-deletion' }],
      ['status', { requestId: randomUUID() }],
    ] as const) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/v1/account/deletion/' + route,
        headers: f.headers,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.body).not.toContain(f.actor.userId);
      expect(response.body).not.toContain(f.actor.controlGrantId);
    }
    expect(f.store.prepare).toHaveBeenCalledWith({
      ...f.query,
      actor: { kind: 'user', userId: f.actor.userId },
    });
    expect(Object.isFrozen(f.factory.mock.calls[0]?.[0])).toBe(true);
    expect(f.controls.authenticate).toHaveBeenCalledTimes(8);
  });
  it('rejects body identity, channel context and extra selectors and exposes no credential issuer', async () => {
    const f = await fixture();
    for (const extra of [
      { actor: { kind: 'user', userId: f.actor.userId } },
      { channelContext: { channel: 'telegram' } },
      { userId: randomUUID() },
      { productEpoch: 1 },
    ]) {
      const r = await f.app.inject({
        method: 'POST',
        url: '/v1/account/deletion/prepare',
        headers: f.headers,
        payload: { ...f.query, ...extra },
      });
      expect(r.statusCode).toBe(400);
    }
    const absent = await f.app.inject({
      method: 'POST',
      url: '/v1/account/deletion/prepare',
      payload: f.query,
    });
    expect(absent.statusCode).toBe(401);
    expect(f.store.prepare).not.toHaveBeenCalled();
    const issue = await f.app.inject({
      method: 'POST',
      url: '/v1/account/deletion/issue',
      headers: f.headers,
      payload: {},
    });
    expect(issue.statusCode).toBe(404);
  });
  it('rechecks the same native grant after waits and rejects epoch, user or authority substitution', async () => {
    const f = await fixture();
    for (const replacement of [
      undefined,
      { ...f.actor, productEpoch: 1 },
      { ...f.actor, userId: randomUUID() },
      { ...f.actor, controlGrantId: randomUUID() },
    ]) {
      f.controls.authenticate.mockResolvedValueOnce(f.actor).mockResolvedValueOnce(replacement);
      const response = await f.app.inject({
        method: 'POST',
        url: '/v1/account/deletion/status',
        headers: f.headers,
        payload: { requestId: randomUUID() },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(f.status.requestedAt);
    }
  });
  it('sanitizes private store failures and refuses unapproved response fields', async () => {
    const f = await fixture(),
      privateText = 'private-provider-object-and-retention-manifest';
    f.store.prepare.mockRejectedValueOnce(
      new ApplicationError('forbidden', privateText, 403, { privateText }),
    );
    let response = await f.app.inject({
      method: 'POST',
      url: '/v1/account/deletion/prepare',
      headers: f.headers,
      payload: f.query,
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(privateText);
    f.store.status.mockResolvedValueOnce(Object.assign({}, f.status, { privateText }));
    response = await f.app.inject({
      method: 'POST',
      url: '/v1/account/deletion/status',
      headers: f.headers,
      payload: { requestId: randomUUID() },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(privateText);
  });
});
