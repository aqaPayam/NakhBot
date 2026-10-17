import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@nakh/config';
import type { NakhDatabase } from '@nakh/persistence-postgres';
import { PostgresTelegramUserResolver } from '@nakh/persistence-postgres';
import type { createRedisConnection } from '@nakh/queue-redis';
import { createTelegramReportRuntime } from './report-runtime.js';
const token = `12345:${'a'.repeat(24)}`;
const config = {
  telegram: {
    reportsEnabled: true,
    botTokenRef: 'BOT',
    actionTokenKeyRef: 'NAV',
    reportSnapshotKeyId: 'report-key',
    reportSnapshotKeyVersion: 1,
  },
  deletion: { evidenceKeyRingRef: 'RING' },
  redis: { queuePrefix: 'test' },
} as AppConfig;
function fixture(): {
  secrets: Record<string, string>;
  resolveSecret: ReturnType<typeof vi.fn<(name: string) => string>>;
  database: NakhDatabase;
  redis: ReturnType<typeof createRedisConnection>;
} {
  const secrets = {
    BOT: token,
    NAV: Buffer.alloc(32, 154).toString('base64url'),
    RING: JSON.stringify([
      { keyId: 'report-key', keyVersion: 1, key: Buffer.alloc(32, 73).toString('base64url') },
    ]),
  };
  return {
    secrets,
    resolveSecret: vi.fn((name: string) => secrets[name as keyof typeof secrets]),
    database: {} as NakhDatabase,
    redis: {} as ReturnType<typeof createRedisConnection>,
  };
}
describe('public report process composition', () => {
  it('leaves an unrelated private reply available to account controls when there is no product life', async () => {
    const f = fixture(),
      runtime = createTelegramReportRuntime({ ...f, config });
    const lookup = vi
      .spyOn(PostgresTelegramUserResolver.prototype, 'resolveProductLife')
      .mockResolvedValue(undefined);
    try {
      expect(
        await runtime.handle({
          update_id: 2,
          message: {
            text: 'Account control reply',
            from: { id: 123, is_bot: false },
            chat: { id: 123, type: 'private' },
            reply_to_message: {
              message_id: 10,
              from: { id: 12345, is_bot: true },
              chat: { id: 123, type: 'private' },
            },
          },
        }),
      ).toBe('unhandled');
    } finally {
      lookup.mockRestore();
    }
  });
  it('does not resolve secrets or open services when disabled', async () => {
    const f = fixture(),
      runtime = createTelegramReportRuntime({
        ...f,
        config: { telegram: { reportsEnabled: false } } as AppConfig,
      });
    expect(runtime.enabled).toBe(false);
    expect(await runtime.handle({ update_id: 1, message: { text: '/start' } })).toBe('unhandled');
    expect(f.resolveSecret).not.toHaveBeenCalled();
  });
  it('preloads explicit snapshot write custody with no signup or Explore dependency', async () => {
    const f = fixture(),
      runtime = createTelegramReportRuntime({ ...f, config });
    expect(runtime.enabled).toBe(true);
    expect(await runtime.handle({ update_id: 1, message: { text: '/start' } })).toBe('unhandled');
    expect(f.resolveSecret.mock.calls.map(([name]) => name)).toEqual(['BOT', 'NAV', 'RING']);
  });
  it('rejects missing write versions and reuse of a historical snapshot key for navigation', () => {
    const f = fixture();
    expect(() =>
      createTelegramReportRuntime({
        ...f,
        config: { ...config, telegram: { ...config.telegram, reportSnapshotKeyVersion: 2 } },
      }),
    ).toThrow('Report snapshot write key unavailable.');
    f.secrets.NAV = Buffer.alloc(32, 73).toString('base64url');
    expect(() => createTelegramReportRuntime({ ...f, config })).toThrow(
      'Report snapshot key configuration unavailable.',
    );
  });
  it('rejects mixed, group, bot and inline report updates before a native lookup', async () => {
    const f = fixture(),
      runtime = createTelegramReportRuntime({ ...f, config });
    const base = {
      update_id: 1,
      callback_query: {
        id: 'callback',
        data: 'm9r:' + 'a'.repeat(16) + ':' + 'b'.repeat(22),
        from: { id: 123, is_bot: false },
        message: {
          message_id: 1,
          from: { id: 12345, is_bot: true },
          chat: { id: 123, type: 'private' },
        },
      },
    };
    const mixed = { ...base, message: { text: '/start' } };
    const group = structuredClone(base);
    group.callback_query.message.chat.type = 'group';
    const bot = structuredClone(base);
    bot.callback_query.from.is_bot = true;
    const inline = {
      ...base,
      callback_query: { ...base.callback_query, inline_message_id: 'inline' },
    };
    for (const update of [mixed, group, bot, inline])
      await expect(runtime.handle(update)).rejects.toMatchObject({ code: 'report_unavailable' });
  });
});
