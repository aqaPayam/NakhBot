import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmedAppealReveals, ConfirmedSupportReveals } from '@nakh/application';
import {
  TelegramAdminSafetyContentAdapter,
  type TelegramConfirmedSafetyRead,
  type TelegramConfirmedSafetyReads,
} from './admin-safety-content-adapter.js';
import type {
  TelegramAdminSessionVerifier,
  VerifiedTelegramAdminSession,
} from './admin-session.js';
import type { TelegramAdminEvidenceDelivery } from './admin-evidence-adapter.js';

const now = new Date('2026-10-04T00:00:00Z');
const update = {
  update_id: 7,
  callback_query: {
    data: `m7s:${'x'.repeat(22)}`,
    from: { id: 123, is_bot: false },
    message: { chat: { type: 'private', id: 123 } },
  },
};
const fixture = (
  kind: 'support' | 'appeal',
): Readonly<{
  actor: VerifiedTelegramAdminSession['actor'];
  session: VerifiedTelegramAdminSession;
  current: ReturnType<typeof vi.fn<TelegramAdminSessionVerifier['current']>>;
  selected: TelegramConfirmedSafetyRead;
  common: Omit<Awaited<ReturnType<ConfirmedSupportReveals['execute']>>, 'value'>;
  support: ReturnType<typeof vi.fn<ConfirmedSupportReveals['execute']>>;
  appeals: ReturnType<typeof vi.fn<ConfirmedAppealReveals['execute']>>;
  text: ReturnType<typeof vi.fn<TelegramAdminEvidenceDelivery['text']>>;
  resolve: ReturnType<typeof vi.fn<TelegramConfirmedSafetyReads['resolve']>>;
  withdraw: ReturnType<typeof vi.fn<NonNullable<TelegramConfirmedSafetyReads['withdraw']>>>;
  adapter: TelegramAdminSafetyContentAdapter;
}> => {
  const actor = { kind: 'admin' as const, userId: randomUUID() };
  const session: VerifiedTelegramAdminSession = {
    actor,
    telegramUserId: '123',
    locale: 'en',
    expiresAt: new Date(now.getTime() + 300000),
    mfaExpiresAt: new Date(now.getTime() + 300000),
  };
  const current = vi.fn<TelegramAdminSessionVerifier['current']>().mockResolvedValue(session);
  const base = {
    commandId: randomUUID(),
    schemaVersion: 1 as const,
    actor,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    occurredAt: now.toISOString(),
    locale: 'en',
    data: {
      adminActionToken: 'trusted-action',
      confirmationToken: 'trusted-confirmation',
      reason: 'review',
      expectedTargetVersion: 1,
    },
  };
  const selected: TelegramConfirmedSafetyRead =
    kind === 'support'
      ? { kind, command: { ...base, commandType: 'support.reveal-thread' } }
      : { kind, command: { ...base, commandType: 'moderation.reveal-appeal' } };
  const common = {
    logId: randomUUID(),
    result: 'succeeded' as const,
    safeCode: 'completed',
    recordedAt: now,
    replayed: false,
  };
  const support = vi.fn<ConfirmedSupportReveals['execute']>().mockResolvedValue({
    ...common,
    value: {
      threadVersion: 1,
      status: 'closed',
      messages: [
        { senderType: 'user', text: 'private user text', createdAt: now.toISOString() },
        { senderType: 'admin', text: 'private reply', createdAt: now.toISOString() },
      ],
      hasEarlierMessages: false,
    },
  });
  const appeals = vi.fn<ConfirmedAppealReveals['execute']>().mockResolvedValue({
    ...common,
    value: { appealVersion: 1, status: 'accepted', text: 'private appeal', note: 'private note' },
  });
  const text = vi.fn<TelegramAdminEvidenceDelivery['text']>().mockResolvedValue(undefined);
  const resolve = vi.fn<TelegramConfirmedSafetyReads['resolve']>().mockResolvedValue(selected);
  const withdraw = vi
    .fn<NonNullable<TelegramConfirmedSafetyReads['withdraw']>>()
    .mockResolvedValue(true);
  return {
    actor,
    session,
    current,
    selected,
    common,
    support,
    appeals,
    text,
    resolve,
    withdraw,
    adapter: new TelegramAdminSafetyContentAdapter(
      { current },
      { resolve, withdraw },
      { execute: support },
      { execute: appeals },
      { text },
      { render: (_locale, intent) => intent.key },
      () => now,
    ),
  };
};
describe('audited Telegram support and appeal content', () => {
  it.each(['support', 'appeal'] as const)(
    'delivers fresh %s content only through its native audited reader',
    async (kind) => {
      const f = fixture(kind);
      await expect(f.adapter.handle(update)).resolves.toBe('notice');
      expect(f.text.mock.calls.map(([input]) => input.text)).toEqual(
        kind === 'support'
          ? ['admin.outcome.succeeded', 'private user text', 'private reply']
          : ['admin.outcome.succeeded', 'private appeal', 'private note'],
      );
      expect(kind === 'support' ? f.appeals : f.support).not.toHaveBeenCalled();
      for (const [input] of f.text.mock.calls) {
        expect(input).toMatchObject({ recipient: '123', disableLinkPreviews: true });
        expect(JSON.stringify(input)).not.toContain(f.actor.userId);
      }
    },
  );
  it.each(['succeeded', 'rejected', 'failed'] as const)(
    'does not deliver content on replay or %s non-success',
    async (result) => {
      const f = fixture('appeal');
      f.appeals.mockResolvedValue({
        ...f.common,
        result,
        replayed: true,
        value: { appealVersion: 1, status: 'submitted', text: 'must not escape' },
      });
      await f.adapter.handle(update);
      expect(f.text.mock.calls.map(([input]) => input.text)).toEqual([`admin.outcome.${result}`]);
      if (result !== 'succeeded') {
        f.text.mockClear();
        f.appeals.mockResolvedValue({
          ...f.common,
          result,
          value: { appealVersion: 1, status: 'submitted', text: 'must not escape' },
        });
        await f.adapter.handle(update);
        expect(f.text.mock.calls.map(([input]) => input.text)).toEqual([`admin.outcome.${result}`]);
      }
    },
  );
  it('rejects stolen actor bindings, invalid sessions, group callbacks and malformed handles before execution', async () => {
    const f = fixture('support');
    f.current.mockResolvedValueOnce(undefined);
    await expect(f.adapter.handle(update)).rejects.toMatchObject({ code: 'unauthorized' });
    if (f.selected.kind !== 'support') throw new Error('Expected support fixture.');
    f.resolve.mockResolvedValueOnce({
      ...f.selected,
      command: { ...f.selected.command, actor: { kind: 'admin', userId: randomUUID() } },
    });
    await expect(f.adapter.handle(update)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      f.adapter.handle({
        ...update,
        callback_query: { ...update.callback_query, data: 'm7s:raw-id' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      f.adapter.handle({
        ...update,
        callback_query: { ...update.callback_query, message: { chat: { type: 'group', id: 123 } } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.support).not.toHaveBeenCalled();
    expect(f.text).not.toHaveBeenCalled();
  });
  it('checks revocation before every outbound chunk and sends no remaining content', async () => {
    const f = fixture('support');
    f.current
      .mockResolvedValueOnce(f.session)
      .mockResolvedValueOnce(f.session)
      .mockResolvedValueOnce(f.session)
      .mockResolvedValueOnce(undefined);
    await expect(f.adapter.handle(update)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.text.mock.calls.map(([input]) => input.text)).toEqual([
      'admin.outcome.succeeded',
      'private user text',
    ]);
    expect(f.support).toHaveBeenCalledTimes(1);
  });
  it('sanitizes provider errors after committed reads and leaves unrelated updates unhandled', async () => {
    const f = fixture('appeal');
    f.text.mockRejectedValueOnce(new Error('private delivery details'));
    await expect(f.adapter.handle(update)).rejects.toMatchObject({
      code: 'internal_error',
      message: 'error.m7.internal',
    });
    expect(f.appeals).toHaveBeenCalledTimes(1);
    await expect(f.adapter.handle({ message: { text: '/support' } })).resolves.toBe('unhandled');
    expect(f.appeals).toHaveBeenCalledTimes(1);
  });
  it('withdraws an owned confirmation without calling either native reader', async () => {
    const f = fixture('support');
    const cancelled = {
      ...update,
      callback_query: { ...update.callback_query, data: `m7c:${'x'.repeat(22)}` },
    };
    await expect(f.adapter.handle(cancelled)).resolves.toBe('notice');
    expect(f.withdraw).toHaveBeenCalledWith(f.actor, 'x'.repeat(22));
    expect(f.support).not.toHaveBeenCalled();
    expect(f.appeals).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    f.withdraw.mockResolvedValueOnce(false);
    await expect(f.adapter.handle(cancelled)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.text).toHaveBeenCalledTimes(1);
  });
  it('stops content when cancellation or cache loss occurs while native execution waits or between chunks', async () => {
    const f = fixture('support');
    f.resolve.mockResolvedValueOnce(f.selected).mockResolvedValueOnce(undefined);
    await expect(f.adapter.handle(update)).rejects.toMatchObject({ code: 'version_conflict' });
    expect(f.support).toHaveBeenCalledTimes(1);
    expect(f.text).not.toHaveBeenCalled();
    f.resolve
      .mockResolvedValueOnce(f.selected)
      .mockResolvedValueOnce(f.selected)
      .mockResolvedValueOnce(undefined);
    await expect(f.adapter.handle(update)).rejects.toMatchObject({ code: 'version_conflict' });
    expect(f.text.mock.calls.map(([input]) => input.text)).toEqual(['admin.outcome.succeeded']);
  });
});
