import { describe, expect, it } from 'vitest';

import type { RegisterTelegramIdentityUseCase } from '@nakh/application';

import { TelegramStartAdapter, TelegramWebhookAuthenticator } from './index.js';

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
