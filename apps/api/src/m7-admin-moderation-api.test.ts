import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfirmedAccountActions,
  ConfirmedPhotoActions,
  ConfirmedInternalBlocks,
  AdminIngressRejectionStore,
} from '@nakh/application';
import type { AdminCommandReceipt } from '@nakh/contracts';
import { ApiExceptionFilter } from './app.js';
import {
  M7AdminModerationApiModule,
  type M7AdminModerationApiOptions,
} from './m7-admin-moderation-api.js';

const actor = { kind: 'admin' as const, userId: randomUUID() },
  headers = { authorization: 'Bearer account-admin-credential' };
const token = `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
  confirmationToken = `v1.cf.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const draft = {
  actor,
  commandId: randomUUID(),
  requestId: randomUUID(),
  commandType: 'moderation.apply-account-action' as const,
  schemaVersion: 1 as const,
  locale: 'en',
  occurredAt: new Date().toISOString(),
  idempotencyKey: randomUUID(),
  data: {
    action: 'ban_user' as const,
    adminActionToken: token,
    expectedTargetVersion: 1,
    reason: 'Private account review',
  },
};
const command = { ...draft, data: { ...draft.data, confirmationToken } };
describe('authenticated route-bound account moderation HTTP', () => {
  let app: NestFastifyApplication | undefined;
  const error = vi.fn();
  afterEach(async () => {
    await app?.close();
    app = undefined;
    error.mockClear();
  });
  async function start(
    overrides: Partial<M7AdminModerationApiOptions> = {},
    includeAccounts = true,
  ): Promise<{
    server: NestFastifyApplication;
    execute: ReturnType<typeof vi.fn<ConfirmedAccountActions['execute']>>;
    record: ReturnType<typeof vi.fn<AdminIngressRejectionStore['record']>>;
  }> {
    const execute = vi.fn<ConfirmedAccountActions['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'account_ban_user',
        recordedAt: new Date(),
        replayed: false,
        value: {
          actionId: randomUUID(),
          targetUserId: randomUUID(),
          previousState: 'active',
          nextState: 'banned',
          accountVersion: 2,
        },
      }),
    );
    const record = vi.fn<AdminIngressRejectionStore['record']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'rejected',
        safeCode: 'invalid_request',
        recordedAt: new Date(),
        replayed: false,
        value: undefined,
      }),
    );
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(actor) },
        ...(includeAccounts
          ? { accounts: { prepare: () => Promise.resolve(confirmationToken), execute } }
          : {}),
        journal: { record, recover: () => Promise.resolve(undefined) },
        ...overrides,
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { server: app, execute, record };
  }
  it('prepares and delegates the exact confirmed action, returning a finite receipt without the internal account result', async () => {
    const { server, execute, record } = await start();
    const prepared = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/ban_user/prepare',
      headers,
      payload: draft,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toEqual({ confirmationToken });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/ban_user',
      headers,
      payload: command,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<AdminCommandReceipt>()).toMatchObject({
      result: 'succeeded',
      safeCode: 'completed',
      replayed: false,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(execute).toHaveBeenCalledWith(command, actor);
    expect(record).not.toHaveBeenCalled();
    for (const restricted of [
      'targetUserId',
      'actionId',
      'accountVersion',
      actor.userId,
      draft.data.reason,
      token,
    ])
      expect(response.body).not.toContain(restricted);
  });
  it('binds photo actions to their route and returns only public receipts after delegation', async () => {
    const execute = vi.fn<ConfirmedPhotoActions['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'photo_hide_photo',
        recordedAt: new Date(),
        replayed: false,
        value: {
          actionId: randomUUID(),
          photoId: randomUUID(),
          profileId: randomUUID(),
          targetUserId: randomUUID(),
          previousStatus: 'visible',
          nextStatus: 'hidden',
          wasPrimary: false,
          primaryPhotoId: randomUUID(),
          photoVersion: 2,
          profileVersion: 2,
          profileCompletion: 'complete',
        },
      }),
    );
    const prepare = vi.fn<ConfirmedPhotoActions['prepare']>(() =>
      Promise.resolve(confirmationToken),
    );
    const { server, record } = await start({ photos: { execute, prepare } }, false);
    const photoDraft = {
      ...draft,
      commandType: 'moderation.apply-photo-action',
      data: { ...draft.data, action: 'hide_photo' },
    };
    const prepared = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/photos/hide_photo/prepare',
      headers,
      payload: photoDraft,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepare).toHaveBeenCalledWith(photoDraft, actor);
    const photoCommand = { ...photoDraft, data: { ...photoDraft.data, confirmationToken } };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/photos/hide_photo',
      headers,
      payload: photoCommand,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'succeeded', safeCode: 'completed' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain('photoId');
    expect(execute).toHaveBeenCalledWith(photoCommand, actor);
    const mismatch = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/photos/delete_photo',
      headers,
      payload: photoCommand,
    });
    expect(mismatch.json()).toMatchObject({ result: 'rejected' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0].requiredPermission).toBe('delete_photo');
  });
  it('binds internal block changes to signed server-held pairs and hides their effect references', async () => {
    const execute = vi.fn<ConfirmedInternalBlocks['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'internal_block_created',
        recordedAt: new Date(),
        replayed: false,
        value: {
          actionId: randomUUID(),
          userLowId: randomUUID(),
          userHighId: randomUUID(),
          previousState: 'matched',
          nextState: 'blocked',
          pairVersion: 2,
          closedMatchId: randomUUID(),
          closedChatSessionId: randomUUID(),
          closedLikeCount: 2,
          revokedUnlockCount: 0,
        },
      }),
    );
    const prepare = vi.fn<ConfirmedInternalBlocks['prepare']>(() =>
      Promise.resolve(confirmationToken),
    );
    const { server, record } = await start({ internalBlocks: { execute, prepare } }, false);
    const blockDraft = {
      ...draft,
      commandType: 'moderation.change-internal-block',
      data: { ...draft.data, action: 'create' },
    };
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/internal-blocks/create/prepare',
          headers,
          payload: blockDraft,
        })
      ).statusCode,
    ).toBe(200);
    expect(prepare).toHaveBeenCalledWith(blockDraft, actor);
    const blockCommand = { ...blockDraft, data: { ...blockDraft.data, confirmationToken } };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/internal-blocks/create',
      headers,
      payload: blockCommand,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'succeeded', safeCode: 'completed' });
    expect(execute).toHaveBeenCalledWith(blockCommand, actor);
    for (const privateField of ['userLowId', 'userHighId', 'closedMatchId', 'closedChatSessionId'])
      expect(response.body).not.toContain(privateField);
    const forged = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/internal-blocks/create',
      headers,
      payload: {
        ...blockCommand,
        data: { ...blockCommand.data, userLowId: randomUUID(), userHighId: randomUUID() },
      },
    });
    expect(forged.json()).toMatchObject({ result: 'rejected' });
    const mismatch = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/internal-blocks/remove',
      headers,
      payload: blockCommand,
    });
    expect(mismatch.json()).toMatchObject({ result: 'rejected' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
    expect(
      record.mock.calls.every(([input]) => input.requiredPermission === 'manage_internal_blocks'),
    ).toBe(true);
  });
  it('rejects a mismatched route action and audits only the server-selected permission before delegation', async () => {
    const { server, execute, record } = await start();
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/unban_user/prepare',
          headers,
          payload: draft,
        })
      ).statusCode,
    ).toBe(400);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/unban_user',
      headers,
      payload: command,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    expect(execute).not.toHaveBeenCalled();
    expect(record.mock.calls[0]?.[0].requiredPermission).toBe('unban_user');
    expect(JSON.stringify(record.mock.calls)).not.toContain(draft.data.reason);
  });
  it('audits malformed authenticated requests and fails closed when the required journal fails', async () => {
    const { server, execute, record } = await start();
    const invalid = {
      ...command,
      actor: { ...actor, userId: randomUUID() },
      targetUserId: randomUUID(),
    };
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/ban_user',
          headers,
          payload: invalid,
        })
      ).json(),
    ).toMatchObject({ result: 'rejected' });
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    record.mockRejectedValueOnce(new Error('PRIVATE DATABASE ERROR'));
    const failed = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/ban_user',
      headers,
      payload: {},
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('PRIVATE');
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE');
  });
  it('keeps missing capabilities unavailable and rejects the wrong authentication audience without auditing', async () => {
    const { server, execute, record } = await start({
      authenticator: {
        authenticate: () => Promise.resolve({ kind: 'user', userId: actor.userId }),
      },
    });
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/ban_user',
          headers,
          payload: command,
        })
      ).statusCode,
    ).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/unknown',
          headers,
          payload: command,
        })
      ).statusCode,
    ).toBe(404);
    await server.close();
    app = undefined;
    const disabled = await start({}, false);
    expect(
      (
        await disabled.server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/ban_user',
          headers,
          payload: command,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('sanitizes malformed JSON and oversized bodies before authenticated command delegation', async () => {
    const { server, execute, record } = await start();
    const privateValue = 'PRIVATE PARSER INPUT';
    for (const [payload, status] of [
      [`{"text":"${privateValue}"`, 400],
      [JSON.stringify({ text: privateValue.repeat(20000) }), 413],
    ] as const) {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/admin/moderation/accounts/ban_user',
        headers: { ...headers, 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain(privateValue);
      expect(JSON.stringify(error.mock.calls)).not.toContain(privateValue);
      expect(JSON.stringify(error.mock.calls)).not.toContain(headers.authorization);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
