import { describe, expect, it } from 'vitest';

import type { RegisterTelegramIdentityUseCase } from '@nakh/application';

import {
  TelegramPhotoDownloadAdapter,
  TelegramStartAdapter,
  TelegramWebhookAuthenticator,
} from './index.js';

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
