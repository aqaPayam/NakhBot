import { describe, expect, it, vi } from 'vitest';

import type {
  BeginTelegramPhotoIngestionHandler,
  RegisterTelegramIdentityUseCase,
} from '@nakh/application';

import {
  TelegramPhotoDownloadAdapter,
  TelegramPhotoIngestionAdapter,
  TelegramPhotoManagementAdapter,
  TelegramStartAdapter,
  TelegramWebhookAuthenticator,
} from './index.js';

describe('TelegramPhotoManagementAdapter', () => {
  const collection = {
    profileVersion: 4,
    photos: [
      {
        id: '40000000-0000-4000-8000-000000000000',
        status: 'visible' as const,
        isPrimary: true,
        displayOrder: 0,
        version: 1,
      },
    ],
  };

  it('resolves the actor and lists only the authoritative owner collection', async () => {
    const list = vi.fn().mockResolvedValue(collection);
    const adapter = new TelegramPhotoManagementAdapter(
      { resolveUserId: (id) => Promise.resolve(id === '123' ? 'user-1' : undefined) },
      { list: { execute: list }, mutate: { execute: vi.fn() } },
    );
    await expect(
      adapter.handle({ update_id: 10, message: { from: { id: 123 }, text: '/photos' } }),
    ).resolves.toEqual({ handled: true, action: 'list', collection });
    expect(list).toHaveBeenCalledWith({ kind: 'user', userId: 'user-1' });
  });

  it('maps a strict versioned command with stable replay identity', async () => {
    const mutate = vi.fn().mockResolvedValue(collection);
    const ids = ['20000000-0000-4000-8000-000000000000', '30000000-0000-4000-8000-000000000000'];
    const adapter = new TelegramPhotoManagementAdapter(
      { resolveUserId: () => Promise.resolve('user-1') },
      { list: { execute: vi.fn() }, mutate: { execute: mutate } },
      undefined,
      () => ids.shift() ?? 'unexpected',
    );
    await expect(
      adapter.handle({
        update_id: 11,
        message: {
          from: { id: 123 },
          text: '/photos_primary 40000000-0000-4000-8000-000000000000 3',
        },
      }),
    ).resolves.toEqual({ handled: true, action: 'select_primary', collection });
    expect(mutate).toHaveBeenCalledWith({
      actor: { kind: 'user', userId: 'user-1' },
      expectedProfileVersion: 3,
      action: { type: 'select_primary', photoId: '40000000-0000-4000-8000-000000000000' },
      commandId: '20000000-0000-4000-8000-000000000000',
      requestId: '30000000-0000-4000-8000-000000000000',
      idempotencyKey: 'telegram-update:11',
    });
  });

  it.each([
    [
      '/photos_delete 40000000-0000-4000-8000-000000000000 5',
      { type: 'delete', photoId: '40000000-0000-4000-8000-000000000000' },
    ],
    [
      '/photos_order 5 40000000-0000-4000-8000-000000000000,50000000-0000-4000-8000-000000000000',
      {
        type: 'reorder',
        orderedPhotoIds: [
          '40000000-0000-4000-8000-000000000000',
          '50000000-0000-4000-8000-000000000000',
        ],
      },
    ],
  ])('maps %s without trusting ownership from the command', async (text, action) => {
    const mutate = vi.fn().mockResolvedValue(collection);
    const adapter = new TelegramPhotoManagementAdapter(
      { resolveUserId: () => Promise.resolve('user-1') },
      { list: { execute: vi.fn() }, mutate: { execute: mutate } },
    );
    await adapter.handle({ update_id: 15, message: { from: { id: 123 }, text } });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'user', userId: 'user-1' },
        expectedProfileVersion: 5,
        action,
        idempotencyKey: 'telegram-update:15',
      }),
    );
  });

  it('rejects malformed, unknown-user, and rate-limited management commands', async () => {
    const useCases = { list: { execute: vi.fn() }, mutate: { execute: vi.fn() } };
    const malformed = new TelegramPhotoManagementAdapter(
      { resolveUserId: () => Promise.resolve('user-1') },
      useCases,
    );
    await expect(
      malformed.handle({
        update_id: 12,
        message: { from: { id: 123 }, text: '/photos_delete x 1' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const unknown = new TelegramPhotoManagementAdapter(
      { resolveUserId: () => Promise.resolve(undefined) },
      useCases,
    );
    await expect(
      unknown.handle({ update_id: 13, message: { from: { id: 123 }, text: '/photos' } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const limited = new TelegramPhotoManagementAdapter(
      { resolveUserId: () => Promise.resolve('user-1') },
      useCases,
      { consume: () => Promise.resolve({ allowed: false, remaining: 0, retryAfterSeconds: 10 }) },
    );
    await expect(
      limited.handle({ update_id: 14, message: { from: { id: 123 }, text: '/photos' } }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(useCases.list.execute).not.toHaveBeenCalled();
    expect(useCases.mutate.execute).not.toHaveBeenCalled();
  });

  it('resolves an actor-bound opaque callback before invoking a mutation', async () => {
    const mutate = vi.fn().mockResolvedValue(collection);
    const resolve = vi.fn().mockResolvedValue({
      expectedProfileVersion: 6,
      action: { type: 'delete', photoId: '40000000-0000-4000-8000-000000000000' },
    });
    const adapter = new TelegramPhotoManagementAdapter(
      { resolveUserId: () => Promise.resolve('user-1') },
      { list: { execute: vi.fn() }, mutate: { execute: mutate } },
      undefined,
      () => '20000000-0000-4000-8000-000000000000',
      { resolve },
    );
    const token = 'v1.pm.abcdefghijklmnop.83u2A2bTH5JUrFIB';
    await expect(
      adapter.handle({
        update_id: 16,
        callback_query: { id: 'callback-1', from: { id: 123 }, data: token },
      }),
    ).resolves.toMatchObject({ handled: true, action: 'delete' });
    expect(resolve).toHaveBeenCalledWith(token, '123');
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'user', userId: 'user-1' },
        expectedProfileVersion: 6,
        idempotencyKey: 'telegram-update:16',
      }),
    );
  });

  it('fails closed for an invalid opaque callback without resolving the user', async () => {
    const resolveUserId = vi.fn();
    const adapter = new TelegramPhotoManagementAdapter(
      { resolveUserId },
      { list: { execute: vi.fn() }, mutate: { execute: vi.fn() } },
      undefined,
      undefined,
      { resolve: () => Promise.resolve(undefined) },
    );
    await expect(
      adapter.handle({
        update_id: 17,
        callback_query: {
          id: 'callback-2',
          from: { id: 123 },
          data: 'v1.pm.abcdefghijklmnop.83u2A2bTH5JUrFIB',
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(resolveUserId).not.toHaveBeenCalled();
  });
});

describe('TelegramPhotoIngestionAdapter', () => {
  it('maps the largest Telegram rendition to a durable authenticated command', async () => {
    const commands: Parameters<BeginTelegramPhotoIngestionHandler['execute']>[0][] = [];
    const useCase: Pick<BeginTelegramPhotoIngestionHandler, 'execute'> = {
      execute: (command) => {
        commands.push(command);
        return Promise.resolve({
          assetId: '40000000-0000-4000-8000-000000000000',
          validationState: 'pending',
          acceptedAt: '2026-09-15T10:00:00.000Z',
          replayed: false,
        });
      },
    };
    const ids = ['20000000-0000-4000-8000-000000000000', '30000000-0000-4000-8000-000000000000'];
    const adapter = new TelegramPhotoIngestionAdapter(
      { resolveUserId: () => Promise.resolve('10000000-0000-4000-8000-000000000000') },
      useCase,
      () => ids.shift() ?? 'unexpected',
      () => new Date('2026-09-15T10:00:00.000Z'),
    );

    await expect(
      adapter.handle({
        update_id: 789,
        message: {
          from: { id: 123456789 },
          photo: [
            {
              file_id: 'large-file',
              file_unique_id: 'large-unique',
              width: 1280,
              height: 720,
              file_size: 42,
            },
            { file_id: 'small-file', file_unique_id: 'small-unique', width: 90, height: 90 },
          ],
        },
      }),
    ).resolves.toMatchObject({ handled: true, result: { validationState: 'pending' } });
    expect(commands).toEqual([
      {
        commandId: '20000000-0000-4000-8000-000000000000',
        commandType: 'media.begin-telegram-photo-ingestion',
        schemaVersion: 1,
        actor: { kind: 'user', userId: '10000000-0000-4000-8000-000000000000' },
        requestId: '30000000-0000-4000-8000-000000000000',
        idempotencyKey: 'telegram-photo:789',
        occurredAt: '2026-09-15T10:00:00.000Z',
        locale: 'en',
        channelContext: { channel: 'telegram', channelIdentityId: '123456789' },
        data: {
          telegramFileId: 'large-file',
          telegramFileUniqueId: 'large-unique',
          declaredSizeBytes: 42,
          declaredMediaType: 'image/jpeg',
        },
      },
    ]);
  });

  it('ignores non-photo updates and rejects photos from unknown users', async () => {
    const useCase: Pick<BeginTelegramPhotoIngestionHandler, 'execute'> = {
      execute: () => Promise.reject(new Error('must not execute')),
    };
    const adapter = new TelegramPhotoIngestionAdapter(
      { resolveUserId: () => Promise.resolve(undefined) },
      useCase,
    );
    await expect(adapter.handle({ update_id: 1, message: { text: 'hello' } })).resolves.toEqual({
      handled: false,
    });
    await expect(
      adapter.handle({
        update_id: 2,
        message: {
          from: { id: 123 },
          photo: [{ file_id: 'file', file_unique_id: 'unique', width: 1, height: 1 }],
        },
      }),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('fails closed when Telegram sends malformed photo metadata', async () => {
    const adapter = new TelegramPhotoIngestionAdapter(
      { resolveUserId: () => Promise.resolve('10000000-0000-4000-8000-000000000000') },
      { execute: () => Promise.reject(new Error('must not execute')) },
    );
    await expect(
      adapter.handle({
        update_id: 3,
        message: {
          from: { id: 123 },
          photo: [{ file_id: 'file', file_unique_id: 'unique', width: 0, height: 1 }],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });
});

describe('Telegram webhook authentication', () => {
  it('accepts only the exact secret', () => {
    const authenticator = new TelegramWebhookAuthenticator('a'.repeat(32));

    expect(authenticator.verify('a'.repeat(32))).toBe(true);
    expect(authenticator.verify('a'.repeat(31))).toBe(false);
    expect(authenticator.verify(undefined)).toBe(false);
  });
});

describe('TelegramStartAdapter', () => {
  it('normalizes /start into the channel-independent command and route model', async () => {
    const commands: Parameters<RegisterTelegramIdentityUseCase['execute']>[0][] = [];
    const useCase: RegisterTelegramIdentityUseCase = {
      execute: (command) => {
        commands.push(command);
        return Promise.resolve({
          context: {
            userId: '10000000-0000-4000-8000-000000000000',
            accountState: 'guest',
            profileCompletion: null,
            visibilityEnabled: true,
            uiLocale: 'en',
            guestPreviewCount: 0,
            guestPreviewLimit: 10,
            entryRoute: 'guest',
            accountVersion: 1,
            settingsVersion: 1,
          },
          created: true,
          replayed: false,
        });
      },
    };
    const ids = ['20000000-0000-4000-8000-000000000000', '30000000-0000-4000-8000-000000000000'];
    const adapter = new TelegramStartAdapter(
      useCase,
      '00000000-0000-4000-8000-000000000001',
      () => ids.shift() ?? 'unexpected',
      () => new Date('2026-09-04T10:00:00.000Z'),
    );

    const result = await adapter.handle({
      update_id: 456,
      message: { text: '/start payload', from: { id: 123456789, username: 'nakh_user' } },
    });

    expect(result).toMatchObject({
      handled: true,
      view: { route: 'guest', title: { key: 'start.guest.title' } },
    });
    expect(commands[0]).toMatchObject({
      idempotencyKey: 'telegram-update:456',
      channelContext: { channel: 'telegram', channelIdentityId: '123456789' },
      data: { telegramUserId: '123456789', updateId: '456', username: 'nakh_user' },
    });
  });

  it('ignores updates that are not /start messages', async () => {
    const useCase: RegisterTelegramIdentityUseCase = {
      execute: () => Promise.reject(new Error('must not execute')),
    };
    const adapter = new TelegramStartAdapter(useCase);
    await expect(
      adapter.handle({ update_id: 1, message: { text: 'hello', from: { id: 2 } } }),
    ).resolves.toEqual({ handled: false });
  });

  it('rate-limits authenticated start traffic before the use case', async () => {
    const useCase: RegisterTelegramIdentityUseCase = {
      execute: () => Promise.reject(new Error('must not execute')),
    };
    const adapter = new TelegramStartAdapter(
      useCase,
      '00000000-0000-4000-8000-000000000001',
      () => '20000000-0000-4000-8000-000000000000',
      () => new Date('2026-09-05T10:00:00.000Z'),
      {
        consume: () => Promise.resolve({ allowed: false, remaining: 0, retryAfterSeconds: 30 }),
      },
    );
    await expect(
      adapter.handle({ update_id: 9, message: { text: '/start', from: { id: 123456789 } } }),
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });
});

describe('TelegramPhotoDownloadAdapter', () => {
  it('gets metadata from Telegram and exposes a streaming response', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    const adapter = new TelegramPhotoDownloadAdapter('token', (url, init) => {
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith('/getFile'))
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg', file_size: 3 } }),
            { status: 200 },
          ),
        );
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      );
    });
    const result = await adapter.download('file-id');
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.body) chunks.push(chunk);
    expect([...chunks.flatMap((chunk) => [...chunk])]).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.telegram.org/bottoken/getFile',
      'https://api.telegram.org/file/bottoken/photos/a.jpg',
    ]);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls.every((call) => call.init?.redirect === 'error')).toBe(true);
  });

  it('rejects a provider supplied path that tries to escape the fixed file endpoint', async () => {
    const adapter = new TelegramPhotoDownloadAdapter('token', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: { file_path: 'https://evil.invalid/file' } }),
          { status: 200 },
        ),
      ),
    );
    await expect(adapter.download('file-id')).rejects.toThrow('metadata');
  });

  it.each([
    '../secret',
    'photos/../secret',
    'photos/%2e%2e/secret',
    'photos/a?token=x',
    'photos/a\\b',
  ])('rejects unsafe file path %s', async (filePath) => {
    const adapter = new TelegramPhotoDownloadAdapter('token', () =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, result: { file_path: filePath } }))),
    );
    await expect(adapter.download('file-id')).rejects.toThrow('metadata');
  });

  it('cancels the network stream when a consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const adapter = new TelegramPhotoDownloadAdapter('token', (url) =>
      Promise.resolve(
        url.endsWith('/getFile')
          ? new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg' } }))
          : new Response(body),
      ),
    );
    const download = await adapter.download('file-id');
    for await (const chunk of download.body) {
      expect(chunk.byteLength).toBe(1);
      break;
    }
    expect(cancelled).toBe(true);
  });
});
