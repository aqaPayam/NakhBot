import { describe, expect, it } from 'vitest';

import type {
  RegisterTelegramIdentityCommand,
  RegisterTelegramIdentityResult,
} from '@nakh/contracts';
import type { Clock, IdGenerator } from '@nakh/domain';

import { RegisterTelegramIdentityHandler } from './register-telegram-identity.js';
import { routeStart } from './start-router.js';
import type { IdentityStore, RegisterTelegramIdentityWrite } from './store.js';

const result: RegisterTelegramIdentityResult = {
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
};

function command(): RegisterTelegramIdentityCommand {
  return {
    commandId: '20000000-0000-4000-8000-000000000000',
    commandType: 'identity.register-telegram-identity' as const,
    schemaVersion: 1 as const,
    actor: { userId: '00000000-0000-4000-8000-000000000001', kind: 'system' as const },
    requestId: '30000000-0000-4000-8000-000000000000',
    idempotencyKey: 'telegram-update:123',
    occurredAt: '2026-09-04T10:00:00.000Z',
    locale: 'en',
    channelContext: { channel: 'telegram' as const, channelIdentityId: '987654321' },
    data: { telegramUserId: '987654321', updateId: '123', username: 'nakh_user' },
  };
}

describe('RegisterTelegramIdentityHandler', () => {
  it('supplies infrastructure IDs and locked defaults to the atomic store operation', async () => {
    let captured: RegisterTelegramIdentityWrite | undefined;
    const store: IdentityStore = {
      registerTelegramIdentity: (write) => {
        captured = write;
        return Promise.resolve(result);
      },
      getByTelegramUserId: () => Promise.resolve(undefined),
      getByUserId: () => Promise.resolve(undefined),
      changeSettings: () => Promise.reject(new Error('must not execute')),
    };
    const values = [
      result.context.userId,
      '40000000-0000-4000-8000-000000000000',
      '50000000-0000-4000-8000-000000000000',
      '60000000-0000-4000-8000-000000000000',
      '70000000-0000-4000-8000-000000000000',
    ];
    const ids: IdGenerator = { uuid: () => values.shift() ?? 'unexpected' };
    const clock: Clock = { now: () => new Date('2026-09-04T10:00:01.000Z') };
    const handler = new RegisterTelegramIdentityHandler(store, ids, clock);

    await expect(handler.execute(command())).resolves.toEqual(result);
    expect(captured).toMatchObject({
      userId: result.context.userId,
      guestPreviewLimit: 10,
      defaultLocale: 'en',
      processedAt: new Date('2026-09-04T10:00:01.000Z'),
    });
  });

  it('rejects a command whose verified Telegram identity context does not match', async () => {
    const store: IdentityStore = {
      registerTelegramIdentity: () => Promise.reject(new Error('must not execute')),
      getByTelegramUserId: () => Promise.resolve(undefined),
      getByUserId: () => Promise.resolve(undefined),
      changeSettings: () => Promise.reject(new Error('must not execute')),
    };
    const handler = new RegisterTelegramIdentityHandler(
      store,
      { uuid: () => '10000000-0000-4000-8000-000000000000' },
      { now: () => new Date() },
    );

    await expect(
      handler.execute({
        ...command(),
        channelContext: { channel: 'telegram', channelIdentityId: 'different' },
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('start router', () => {
  it('returns localization keys and typed intents for every entry route', () => {
    const routes = [
      'guest',
      'continue_signup',
      'main',
      'main_discovery_paused',
      'fix_profile',
      'restricted',
      'ban_appeal',
      'return_decision',
    ] as const;
    for (const route of routes) {
      const view = routeStart(route);
      expect(view.route).toBe(route);
      expect(view.title.key).toMatch(/^start\./u);
      expect(view.title.variables).toEqual({});
      expect(view.actions.every((item) => item.label.key.startsWith('common.button.'))).toBe(true);
    }
  });
});
