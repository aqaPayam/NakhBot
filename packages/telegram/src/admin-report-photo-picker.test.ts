import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { OpaqueTokenStore } from '@nakh/application';
import { TelegramAdminReportQueueState } from './admin-report-queue-state.js';
import { TelegramAdminReportPhotoPicker } from './admin-report-photo-picker.js';
import type { TelegramAdminReportPhotoActions } from './admin-report-photo-actions.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';

async function harness(): Promise<{
  picker: TelegramAdminReportPhotoPicker;
  state: TelegramAdminReportQueueState;
  reference: string;
  actor: { kind: 'admin'; userId: string };
  available: ReturnType<typeof vi.fn<TelegramAdminReportPhotoActions['available']>>;
  prepare: ReturnType<typeof vi.fn<TelegramAdminReportPhotoActions['prepare']>>;
  menu: ReturnType<typeof vi.fn<TelegramAdminTextDelivery['queueMenu']>>;
  selections: { selection: ReturnType<typeof vi.fn> };
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
  const evidence = {
    reportReference,
    evidenceId: randomUUID(),
    evidenceType: 'photo' as const,
    snapshotSchemaVersion: 1,
  };
  const reference = await state.putEvidence(actor, 'evidence', evidence);
  const selections = { selection: vi.fn().mockResolvedValue({ report, evidence }) };
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
    .fn<TelegramAdminReportPhotoActions['available']>()
    .mockImplementation((_id, _choice, action) => Promise.resolve(action !== 'restore_photo'));
  const prepare = vi.fn<TelegramAdminReportPhotoActions['prepare']>().mockResolvedValue('prepared');
  const menu = vi.fn<TelegramAdminTextDelivery['queueMenu']>().mockResolvedValue(undefined);
  const picker = new TelegramAdminReportPhotoPicker(
    '99',
    sessions,
    selections,
    state,
    { available, prepare, check: () => Promise.resolve() },
    { queueMenu: menu, reasonPrompt: () => Promise.resolve(77) },
    { render: (_locale, intent) => intent.key },
  );
  return { picker, state, reference, actor, available, prepare, menu, selections };
}
function callback(reference: string, code: string): unknown {
  return {
    update_id: 2,
    callback_query: {
      from: { id: 123, is_bot: false },
      data: `m7${code}:${reference}`,
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
      text: 'Selected photo reason',
      reply_to_message: { message_id: messageId, from: { id: botId, is_bot: true } },
    },
  };
}
describe('owned selected evidence photo action picker', () => {
  it('offers only native available actions and retains one exact prompt action in a separate purpose', async () => {
    const f = await harness();
    expect(await f.picker.present('123', f.reference)).toBe(true);
    expect(
      f.menu.mock
        .lastCall![0].replyMarkup.inline_keyboard.flat()
        .map((button) => button.callback_data),
    ).toEqual([`m7V:${f.reference}`, `m7P:${f.reference}`]);
    await f.picker.handle(callback(f.reference, 'V'));
    expect(await f.state.promptSelection(f.actor, 77)).toBeUndefined();
    expect(await f.state.photoPrompt(f.actor, 77)).toEqual({
      reference: f.reference,
      photoAction: 'hide_photo',
    });
    await expect(f.picker.handle(callback(f.reference, 'P'))).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await f.picker.handle(reply());
    expect(f.prepare.mock.lastCall).toMatchObject([
      '123',
      { action: 'hide_photo', reason: 'Selected photo reason', operationId: 'bot:99:update:3' },
    ]);
    await expect(f.picker.handle(reply(98))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await f.picker.handle(reply(99, 76))).toBe('unhandled');
  });
  it('preserves metadata-only selection when photo actions are unavailable or the evidence is another type', async () => {
    const f = await harness();
    f.available.mockResolvedValue(false);
    expect(await f.picker.present('123', f.reference)).toBe(false);
    expect(f.menu).not.toHaveBeenCalled();
    f.selections.selection.mockResolvedValue({ evidence: { evidenceType: 'profile' } });
    expect(await f.picker.present('123', f.reference)).toBe(false);
    expect(f.available).toHaveBeenCalledTimes(3);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rechecks selection before the owned reply and rejects wrong callback purposes or malformed references', async () => {
    const f = await harness();
    await f.picker.handle(callback(f.reference, 'V'));
    f.selections.selection.mockRejectedValueOnce(new Error('Private provider detail'));
    await expect(f.picker.handle(reply())).rejects.toMatchObject({
      message: 'error.m7.internal',
      status: 500,
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(await f.picker.handle(callback(f.reference, 'J'))).toBe('unhandled');
    await expect(f.picker.handle(callback('bad', 'V'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
