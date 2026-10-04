import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@nakh/domain';
import type {
  GetAdminReportQueueActionsHandler,
  GetReportMetadataPageHandler,
  OpaqueTokenStore,
} from '@nakh/application';
import { TelegramAdminReportQueue } from './admin-report-queue.js';
import { TelegramAdminReportQueueState } from './admin-report-queue-state.js';
import { TelegramAdminSafetyQueueState } from './admin-safety-queue-state.js';
import type { TelegramAdminReportAssignments } from './admin-report-assignments.js';
import type { TelegramAdminTextDelivery } from './admin-text-delivery.js';
import type { TelegramAdminSessionVerifier } from './admin-session.js';
class Harness {
  public now = new Date();
  public revoked = false;
  public actor = { kind: 'admin' as const, userId: randomUUID() };
  public rows = new Map<string, string>();
  public tokens: OpaqueTokenStore = {
    get: (key) => Promise.resolve(this.rows.get(key)),
    putIfAbsent: (key, value) => {
      const absent = !this.rows.has(key);
      if (absent) this.rows.set(key, value);
      return Promise.resolve(absent);
    },
  };
  public sessions = {
    current: vi.fn<TelegramAdminSessionVerifier['current']>().mockImplementation(() =>
      Promise.resolve(
        this.revoked
          ? undefined
          : {
              actor: this.actor,
              telegramUserId: '123',
              locale: 'en',
              expiresAt: new Date(this.now.getTime() + 300000),
              mfaExpiresAt: new Date(this.now.getTime() + 300000),
            },
      ),
    ),
  };
  public state = new TelegramAdminReportQueueState(
    this.tokens,
    new Uint8Array(32).fill(1),
    new Uint8Array(32).fill(2),
    () => this.now.getTime(),
  );
  public queues = vi.fn<GetAdminReportQueueActionsHandler['execute']>().mockResolvedValue({
    metadataActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
    claimActionToken: `v1.ad.${'c'.repeat(16)}.${'d'.repeat(16)}`,
  });
  public item = {
    reportId: randomUUID(),
    reasonCode: 'harassment',
    evidenceTypes: ['photo'] as ['photo'],
    status: 'pending_review' as const,
    priority: 'threshold' as const,
    submittedAt: '2026-10-04T12:00:00.000Z',
    priorReportCount: 4,
    version: 2,
  };
  public reports = vi.fn<GetReportMetadataPageHandler['execute']>().mockImplementation(() =>
    Promise.resolve({
      items: [this.item],
      nextCursor: `v1.m7.${'e'.repeat(16)}.${'f'.repeat(16)}`,
    }),
  );
  public check = vi.fn<TelegramAdminReportAssignments['check']>().mockResolvedValue(undefined);
  public prepare = vi.fn<TelegramAdminReportAssignments['prepare']>().mockResolvedValue('prepared');
  public menu = vi.fn<TelegramAdminTextDelivery['queueMenu']>().mockResolvedValue(undefined);
  public prompt = vi.fn<TelegramAdminTextDelivery['reasonPrompt']>().mockResolvedValue(77);
  public text = vi.fn<TelegramAdminTextDelivery['text']>().mockResolvedValue(undefined);
  public adapter = new TelegramAdminReportQueue(
    '99',
    this.sessions,
    { execute: this.queues },
    { execute: this.reports },
    this.state,
    { check: this.check, prepare: this.prepare },
    { queueMenu: this.menu, reasonPrompt: this.prompt, text: this.text },
    { render: (_locale, intent) => intent.key },
    () => this.now,
  );
}
function message(text: string): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      from: { id: 123, is_bot: false },
      chat: { id: 123, type: 'private' },
      date: 1000,
      text,
    },
  };
}
function callback(data: string): Record<string, unknown> {
  return {
    update_id: 2,
    callback_query: {
      from: { id: 123, is_bot: false },
      message: { chat: { id: 123, type: 'private' } },
      data,
    },
  };
}
function reply(text: string, botId = 99, promptId = 77): Record<string, unknown> {
  return {
    update_id: 3,
    message: {
      from: { id: 123, is_bot: false },
      chat: { id: 123, type: 'private' },
      date: 1001,
      text,
      reply_to_message: { message_id: promptId, from: { id: botId, is_bot: true } },
    },
  };
}
describe('private metadata report queue and owned assignment prompt', () => {
  it('uses bounded native keyset pages, hides IDs and binds only the exact owned reply to server selection', async () => {
    const f = new Harness();
    await Promise.all(
      Array.from({ length: 10 }, () => f.adapter.handle(message('/admin_reports'))),
    );
    expect(f.reports.mock.calls[0]![0]).toMatchObject({
      actor: f.actor,
      status: 'pending_review',
      limit: 10,
    });
    const menu = f.menu.mock.calls[0]![0],
      select = menu.replyMarkup.inline_keyboard[0]![0].callback_data,
      next = menu.replyMarkup.inline_keyboard[1]![0].callback_data;
    expect(select).toMatch(/^m7T:[A-Za-z0-9_-]{22}$/u);
    for (const call of f.menu.mock.calls)
      expect(call[0].replyMarkup.inline_keyboard[0]![0].callback_data).toBe(select);
    expect(JSON.stringify(f.menu.mock.calls)).not.toContain(f.item.reportId);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
    await f.adapter.handle(callback(select));
    expect(f.check).toHaveBeenCalledWith(
      '123',
      expect.objectContaining({ targetId: f.item.reportId, expectedVersion: 2, kind: 'report' }),
    );
    expect(f.prepare).not.toHaveBeenCalled();
    await expect(f.adapter.handle(reply('Review reason', 98))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(f.adapter.handle(reply('Review reason', 99, 78))).resolves.toBe('unhandled');
    await f.adapter.handle(reply('Review reason\nWhole bounded reason'));
    expect(f.prepare).toHaveBeenCalledWith(
      '123',
      expect.objectContaining({
        reason: 'Review reason\nWhole bounded reason',
        operationId: 'bot:99:update:3',
        occurredAt: new Date(1001000).toISOString(),
      }),
    );
    await f.adapter.handle(callback(next));
    expect(f.reports.mock.calls.at(-1)![0].cursor).toBe(
      `v1.m7.${'e'.repeat(16)}.${'f'.repeat(16)}`,
    );
  });
  it('does not prompt on native denial, cache loss, group updates or revoked current session', async () => {
    const f = new Harness();
    await f.adapter.handle(message('/admin_reports'));
    const select = f.menu.mock.calls[0]![0].replyMarkup.inline_keyboard[0]![0].callback_data;
    f.check.mockRejectedValueOnce(new ApplicationError('forbidden', 'error.m7.unavailable', 403));
    await expect(f.adapter.handle(callback(select))).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.prompt).not.toHaveBeenCalled();
    f.check.mockImplementationOnce(() => {
      f.rows.clear();
      return Promise.resolve();
    });
    await expect(f.adapter.handle(callback(select))).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect(f.prompt).not.toHaveBeenCalled();
    f.revoked = true;
    await expect(f.adapter.handle(message('/admin_reports'))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(f.prepare).not.toHaveBeenCalled();
    const group = {
      ...message('/admin_reports'),
      message: {
        from: { id: 123, is_bot: false },
        chat: { id: 123, type: 'group' },
        date: 1000,
        text: '/admin_reports',
      },
    };
    await expect(f.adapter.handle(group)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('isolates queue purpose, preserves prompt binding and expires references independently of TTL', async () => {
    const f = new Harness();
    await f.adapter.handle(message('/admin_reports'));
    const ref = f.menu.mock.calls[0]![0].replyMarkup.inline_keyboard[0]![0].callback_data.slice(4);
    const safety = new TelegramAdminSafetyQueueState(
      f.tokens,
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      () => f.now.getTime(),
    );
    await expect(safety.choice(f.actor, ref)).resolves.toBeUndefined();
    await expect(
      f.state.choice({ kind: 'admin', userId: randomUUID() }, ref),
    ).resolves.toBeUndefined();
    await f.state.bindPrompt(f.actor, 77, ref);
    const second = await f.state.putChoice(f.actor, 'second', {
      kind: 'report',
      queueActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      targetId: randomUUID(),
      expectedVersion: 1,
    });
    await expect(f.state.bindPrompt(f.actor, 77, second)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    f.now = new Date(f.now.getTime() + 300000);
    await expect(f.state.choice(f.actor, ref)).resolves.toBeUndefined();
    await expect(f.state.prompt(f.actor, 77)).resolves.toBeUndefined();
  });
  it('bounds filters/pages, preserves unrelated replies and sanitizes unexpected failures', async () => {
    const f = new Harness();
    await expect(f.adapter.handle(message('/support help'))).resolves.toBe('unhandled');
    await expect(f.adapter.handle(reply('unrelated'))).resolves.toBe('unhandled');
    await expect(
      f.adapter.handle(message('/admin_reports pending_review extra')),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.adapter.handle(message('/admin_reports unknown'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    f.reports.mockResolvedValueOnce({ items: Array.from({ length: 11 }, () => f.item) });
    await expect(f.adapter.handle(message('/admin_reports'))).rejects.toMatchObject({
      message: 'error.m7.internal',
    });
    expect(f.menu).not.toHaveBeenCalled();
    f.reports.mockRejectedValueOnce(new Error('private database query'));
    await expect(f.adapter.handle(message('/admin_reports'))).rejects.toMatchObject({
      message: 'error.m7.internal',
    });
  });
});

describe('assigned report action picker', () => {
  it('offers only native available decisions and binds first-line reason and optional note to the exact owned action prompt', async () => {
    const f = new Harness();
    const decisions = {
      check: vi.fn().mockResolvedValue(undefined),
      available: vi
        .fn()
        .mockImplementation((_user, _choice, action) => Promise.resolve(action === 'dismissed')),
      prepare: vi.fn().mockResolvedValue('decision'),
    };
    const adapter = new TelegramAdminReportQueue(
      '99',
      f.sessions,
      { execute: f.queues },
      { execute: f.reports },
      f.state,
      { check: f.check, prepare: f.prepare },
      { queueMenu: f.menu, reasonPrompt: f.prompt, text: f.text },
      { render: (_locale, intent) => intent.key },
      () => f.now,
      decisions,
    );
    await adapter.handle(message('/admin_reports'));
    const choice = f.menu.mock.calls[0]![0].replyMarkup.inline_keyboard[0]![0].callback_data;
    await adapter.handle(callback(choice));
    expect(f.prompt).not.toHaveBeenCalled();
    const codes = f.menu.mock.calls[1]![0].replyMarkup.inline_keyboard.flat().map(
      (button) => button.callback_data,
    );
    expect(codes).toEqual([choice.replace('m7T:', 'm7I:'), choice.replace('m7T:', 'm7D:')]);
    await adapter.handle(callback(codes[1]!));
    await adapter.handle(reply('Reason first line\nPrivate multiline\nnote'));
    expect(decisions.prepare.mock.calls[0]).toMatchObject([
      '123',
      {
        action: 'dismissed',
        reason: 'Reason first line',
        note: 'Private multiline\nnote',
        choice: { targetId: f.item.reportId, expectedVersion: 2 },
      },
    ]);
    expect(f.prepare).not.toHaveBeenCalled();
    decisions.check.mockRejectedValue(
      new ApplicationError('forbidden', 'error.m7.unavailable', 403),
    );
    await expect(adapter.handle(callback(choice.replace('m7T:', 'm7A:')))).rejects.toMatchObject({
      status: 403,
    });
    expect(f.prompt).toHaveBeenCalledTimes(1);
  });
});
