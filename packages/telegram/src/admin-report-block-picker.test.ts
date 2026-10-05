import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { OpaqueTokenStore } from '@nakh/application';
import { TelegramAdminReportQueueState } from './admin-report-queue-state.js';
import { TelegramAdminReportBlockPicker } from './admin-report-block-picker.js';
import type { TelegramAdminReportInternalBlocks } from './admin-report-internal-blocks.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';

async function harness(): Promise<{
  picker: TelegramAdminReportBlockPicker;
  state: TelegramAdminReportQueueState;
  reference: string;
  actor: { kind: 'admin'; userId: string };
  available: ReturnType<typeof vi.fn<TelegramAdminReportInternalBlocks['available']>>;
  prepare: ReturnType<typeof vi.fn<TelegramAdminReportInternalBlocks['prepare']>>;
  menu: ReturnType<typeof vi.fn<TelegramAdminTextDelivery['queueMenu']>>;
}> {
  const actor = { kind: 'admin' as const, userId: randomUUID() },
    now = new Date(),
    values = new Map<string, string>();
  const tokens: OpaqueTokenStore = {
    get: (key) => Promise.resolve(values.get(key)),
    putIfAbsent: (key, value) => {
      const absent = !values.has(key);
      if (absent) values.set(key, value);
      return Promise.resolve(absent);
    },
  };
  const state = new TelegramAdminReportQueueState(
    tokens,
    new Uint8Array(32).fill(1),
    new Uint8Array(32).fill(2),
  );
  const report = {
    kind: 'report' as const,
    targetId: randomUUID(),
    queueActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    expectedVersion: 2,
  };
  const reportReference = await state.putChoice(actor, 'report', report);
  const reference = reportReference;
  const sessions: TelegramAdminSessionVerifier = {
    current: () =>
      Promise.resolve({
        actor,
        telegramUserId: '123',
        locale: 'en',
        expiresAt: new Date(now.getTime() + 300000),
        mfaExpiresAt: new Date(now.getTime() + 300000),
      }),
  };
  const available = vi
    .fn<TelegramAdminReportInternalBlocks['available']>()
    .mockImplementation((_id, _choice, action) => Promise.resolve(action !== 'remove'));
  const prepare = vi
    .fn<TelegramAdminReportInternalBlocks['prepare']>()
    .mockResolvedValue('prepared');
  const menu = vi.fn<TelegramAdminTextDelivery['queueMenu']>().mockResolvedValue(undefined);
  const picker = new TelegramAdminReportBlockPicker(
    '99',
    sessions,
    state,
    { available, prepare, check: () => Promise.resolve() },
    { queueMenu: menu, reasonPrompt: () => Promise.resolve(77) },
    { render: (_locale, intent) => intent.key },
  );
  return { picker, state, reference, actor, available, prepare, menu };
}
function callback(reference: string, code: string): unknown {
  return {
    update_id: 2,
    callback_query: {
      from: { id: 123, is_bot: false },
      data: `m7b${code}:${reference}`,
      message: { chat: { id: 123, type: 'private' } },
    },
  };
}
function reply(botId = 99, messageId = 77): unknown {
  return {
    update_id: 3,
    message: {
      from: { id: 123, is_bot: false },
      chat: { id: 123, type: 'private' },
      date: 1000,
      text: 'Selected block reason',
      reply_to_message: { message_id: messageId, from: { id: botId, is_bot: true } },
    },
  };
}
describe('owned Report block reason picker', () => {
  it('offers only native available actions and retains one exact prompt action in a separate purpose', async () => {
    const f = await harness();
    await f.picker.handle(callback(f.reference, 'C'));
    expect(await f.state.promptSelection(f.actor, 77)).toBeUndefined();
    expect(await f.state.blockPrompt(f.actor, 77)).toEqual({
      reference: f.reference,
      blockAction: 'create',
    });
    await expect(f.picker.handle(callback(f.reference, 'R'))).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await f.picker.handle(reply());
    expect(f.prepare.mock.lastCall).toMatchObject([
      '123',
      { action: 'create', reason: 'Selected block reason', operationId: 'bot:99:update:3' },
    ]);
    await expect(f.picker.handle(reply(98))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await f.picker.handle(reply(99, 76))).toBe('unhandled');
  });
  it('rechecks selection before the owned reply and rejects wrong callback purposes or malformed references', async () => {
    const f = await harness();
    await f.picker.handle(callback(f.reference, 'C'));
    vi.spyOn(f.state, 'choice').mockRejectedValueOnce(new Error('Private provider detail'));
    await expect(f.picker.handle(reply())).rejects.toMatchObject({
      message: 'error.m7.internal',
      status: 500,
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(await f.picker.handle(callback(f.reference, 'J'))).toBe('unhandled');
    await expect(f.picker.handle(callback('bad', 'C'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
