import { describe, expect, it } from 'vitest';

import type { ChangeVisibilityCommand } from '@nakh/contracts';
import type { Clock, IdGenerator } from '@nakh/domain';

import { ChangeSettingsHandler } from './change-settings.js';
import type { ChangeSettingsWrite, IdentityStore } from './store.js';

function command(kind: 'user' | 'admin' | 'system' = 'user'): ChangeVisibilityCommand {
  return {
    commandId: '20000000-0000-4000-8000-000000000001',
    commandType: 'identity.change-visibility',
    schemaVersion: 1,
    actor: { kind, userId: '10000000-0000-4000-8000-000000000001' },
    requestId: '30000000-0000-4000-8000-000000000001',
    idempotencyKey: 'settings-command-1',
    occurredAt: '2026-09-04T10:00:00.000Z',
    locale: 'en',
    data: { visibilityEnabled: false, expectedSettingsVersion: 1 },
  };
}

function store(changeSettings: IdentityStore['changeSettings']): IdentityStore {
  return {
    registerTelegramIdentity: () => Promise.reject(new Error('must not execute')),
    getByTelegramUserId: () => Promise.resolve(undefined),
    getByUserId: () => Promise.resolve(undefined),
    changeSettings,
  };
}

describe('ChangeSettingsHandler', () => {
  it('adds infrastructure metadata and delegates one atomic write', async () => {
    let captured: ChangeSettingsWrite | undefined;
    const generatedIds = [
      '40000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
    ];
    const handler = new ChangeSettingsHandler(
      store((write) => {
        captured = write;
        return Promise.resolve({
          userId: write.command.actor.userId,
          uiLocale: 'en',
          visibilityEnabled: false,
          settingsVersion: 2,
          changed: true,
          replayed: false,
        });
      }),
      { uuid: () => generatedIds.shift() ?? 'unexpected' } satisfies IdGenerator,
      { now: () => new Date('2026-09-04T10:00:01.000Z') } satisfies Clock,
    );

    await expect(handler.execute(command())).resolves.toMatchObject({ settingsVersion: 2 });
    expect(captured).toMatchObject({
      auditId: '40000000-0000-4000-8000-000000000001',
      eventId: '50000000-0000-4000-8000-000000000001',
      processedAt: new Date('2026-09-04T10:00:01.000Z'),
    });
  });

  it.each(['admin', 'system'] as const)('rejects a %s actor before persistence', async (kind) => {
    const handler = new ChangeSettingsHandler(
      store(() => Promise.reject(new Error('must not execute'))),
      { uuid: () => '40000000-0000-4000-8000-000000000001' },
      { now: () => new Date() },
    );

    await expect(handler.execute(command(kind))).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'error.identity.user_context_invalid',
    });
  });
});
