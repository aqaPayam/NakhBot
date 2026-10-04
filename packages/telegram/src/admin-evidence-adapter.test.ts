import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmedEvidenceReveals } from '@nakh/application';
import {
  TelegramAdminEvidenceAdapter,
  chunkM7EvidenceText,
  type TelegramAdminEvidenceDelivery,
  type TelegramAdminSessionVerifier,
  type VerifiedTelegramAdminSession,
} from './admin-evidence-adapter.js';
type Result = Awaited<ReturnType<ConfirmedEvidenceReveals['execute']>>;
const now = new Date('2026-10-04T00:00:00Z');
const reference = 'x'.repeat(22);
const update: unknown = {
  update_id: 1,
  mfa: true,
  actor: { userId: 'forged' },
  callback_query: {
    data: `m7e:${reference}`,
    from: { id: 123, is_bot: false },
    message: { chat: { type: 'private', id: 123 } },
  },
};
function fixture(content: NonNullable<Result['value']>['content']): Readonly<{
  adapter: TelegramAdminEvidenceAdapter;
  session: VerifiedTelegramAdminSession;
  current: ReturnType<typeof vi.fn<TelegramAdminSessionVerifier['current']>>;
  execute: ReturnType<typeof vi.fn<ConfirmedEvidenceReveals['execute']>>;
  text: ReturnType<typeof vi.fn<TelegramAdminEvidenceDelivery['text']>>;
  photo: ReturnType<typeof vi.fn<TelegramAdminEvidenceDelivery['retainedPhoto']>>;
  result: Result;
}> {
  const actor = { kind: 'admin' as const, userId: randomUUID() };
  const session = {
    actor,
    telegramUserId: '123',
    locale: 'fa',
    expiresAt: new Date(now.getTime() + 300000),
    mfaExpiresAt: new Date(now.getTime() + 300000),
  };
  const current = vi.fn<TelegramAdminSessionVerifier['current']>().mockResolvedValue(session);
  const command: Parameters<ConfirmedEvidenceReveals['execute']>[0] = {
    commandId: randomUUID(),
    commandType: 'moderation.reveal-evidence',
    schemaVersion: 1,
    actor,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    occurredAt: now.toISOString(),
    locale: 'fa',
    data: {
      evidenceId: randomUUID(),
      adminActionToken: 'trusted-action-token',
      confirmationToken: 'trusted-confirmation-token',
      reason: 'review evidence',
    },
  };
  const result: Result = {
    logId: randomUUID(),
    result: 'succeeded',
    safeCode: 'completed',
    recordedAt: now,
    replayed: false,
    value: {
      evidenceId: command.data.evidenceId,
      snapshotSchemaVersion: 1,
      content,
      accessedAt: now.toISOString(),
    },
  };
  const execute = vi.fn<ConfirmedEvidenceReveals['execute']>().mockResolvedValue(result);
  const text = vi.fn<TelegramAdminEvidenceDelivery['text']>().mockResolvedValue(undefined),
    photo = vi.fn<TelegramAdminEvidenceDelivery['retainedPhoto']>().mockResolvedValue(undefined);
  return {
    session,
    current,
    execute,
    text,
    photo,
    result,
    adapter: new TelegramAdminEvidenceAdapter(
      { current },
      {
        resolve: (viewer, handle) =>
          Promise.resolve(
            viewer.userId === actor.userId && handle === reference ? command : undefined,
          ),
      },
      { execute },
      { text, retainedPhoto: photo },
      { render: (_locale, intent) => intent.key },
      () => now,
    ),
  };
}
describe('audited Telegram admin evidence presentation', () => {
  it('requires current session/MFA and checks it again before delivery', async () => {
    const f = fixture({
      evidenceType: 'message',
      messageId: randomUUID(),
      messageType: 'text',
      content: 'private text',
      createdAt: now.toISOString(),
    });
    f.current.mockResolvedValueOnce(undefined);
    await expect(f.adapter.handle(update)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.execute).not.toHaveBeenCalled();
    f.current
      .mockResolvedValueOnce(f.session)
      .mockResolvedValueOnce({ ...f.session, mfaExpiresAt: now });
    await expect(f.adapter.handle(update)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.text).not.toHaveBeenCalled();
  });
  it('delivers fresh audited text in bounded plain chunks and never repeats content on replay or rejection', async () => {
    const privateText = '🙂'.repeat(2000) + '\n<b>literal</b> https://private.invalid';
    const messageId = randomUUID(),
      f = fixture({
        evidenceType: 'message',
        messageId,
        messageType: 'text',
        content: privateText,
        createdAt: now.toISOString(),
      });
    await expect(f.adapter.handle(update)).resolves.toBe('notice');
    const body = f.text.mock.calls
      .slice(1)
      .map(([input]) => input.text)
      .join('');
    expect(body).toBe(privateText);
    for (const [input] of f.text.mock.calls) {
      expect(input.text.length).toBeLessThanOrEqual(3500);
      expect(input.disableLinkPreviews).toBe(true);
      expect(input).not.toHaveProperty('parse_mode');
      expect(input.text).not.toContain(messageId);
    }
    f.text.mockClear();
    f.execute.mockResolvedValue({ ...f.result, replayed: true });
    await f.adapter.handle(update);
    expect(f.text.mock.calls.map(([input]) => input.text)).toEqual(['admin.outcome.succeeded']);
    f.text.mockClear();
    f.execute.mockResolvedValue({ ...f.result, result: 'rejected', safeCode: 'forbidden' });
    await f.adapter.handle(update);
    expect(f.text.mock.calls.map(([input]) => input.text)).toEqual(['admin.outcome.rejected']);
  });
  it('uses the explicit retained-photo port and does not put storage references into text', async () => {
    const objectRef = 'v1.retained.private-photo-reference',
      f = fixture({
        evidenceType: 'photo',
        evidenceObjectRef: objectRef,
        contentSha256: 'a'.repeat(64),
        primary: true,
      });
    await f.adapter.handle(update);
    expect(f.photo).toHaveBeenCalledWith({
      actor: f.session.actor,
      recipient: '123',
      objectRef,
      contentSha256: 'a'.repeat(64),
    });
    expect(JSON.stringify(f.text.mock.calls)).not.toContain(objectRef);
    f.execute.mockResolvedValue({ ...f.result, replayed: true });
    await f.adapter.handle(update);
    expect(f.photo).toHaveBeenCalledTimes(1);
  });
  it.each([
    { evidenceType: 'profile', displayName: 'Private name', birthYear: 1995, bio: 'Private bio' },
    {
      evidenceType: 'chat',
      chatSessionId: randomUUID(),
      status: 'closed',
      closedAt: now.toISOString(),
    },
    {
      evidenceType: 'unmatched_user',
      unmatchedAt: now.toISOString(),
      reportWindowExpiresAt: now.toISOString(),
    },
  ] as const)('projects only permitted %s fields', async (content) => {
    const f = fixture(content);
    await f.adapter.handle(update);
    expect(f.text).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.text.mock.calls)).not.toContain('chatSessionId');
    if ('chatSessionId' in content)
      expect(JSON.stringify(f.text.mock.calls)).not.toContain(content.chatSessionId);
  });
  it('preserves Unicode boundaries and sanitizes provider failure after the audit already committed', async () => {
    const chunks = chunkM7EvidenceText('🙂'.repeat(2000));
    expect(chunks.join('')).toBe('🙂'.repeat(2000));
    const f = fixture({ evidenceType: 'profile', displayName: 'Private name', birthYear: 1995 });
    f.text.mockRejectedValueOnce(new Error('private provider parameters'));
    await expect(f.adapter.handle(update)).rejects.toMatchObject({
      code: 'internal_error',
      message: 'error.m7.internal',
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.photo).not.toHaveBeenCalled();
    expect(await f.adapter.handle({ edited_message: { text: 'm7e:' } })).toBe('unhandled');
  });
});
