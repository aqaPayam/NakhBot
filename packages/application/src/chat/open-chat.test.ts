import { describe, expect, it, vi } from 'vitest';

import {
  GetChatCapabilityHandler,
  OpenChatForMatchHandler,
  type StoredChatCapability,
} from './open-chat.js';

const userId = '10000000-0000-4000-8000-000000000001';
const matchId = '10000000-0000-4000-8000-000000000002';
const chatSessionId = '10000000-0000-4000-8000-000000000003';
const matchToken = `v1.mt.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const chatToken = `v1.ch.${'c'.repeat(16)}.${'d'.repeat(16)}`;
const refreshedToken = `v1.ch.${'e'.repeat(16)}.${'f'.repeat(16)}`;
const envelope = {
  commandId: '10000000-0000-4000-8000-000000000004',
  schemaVersion: 1 as const,
  actor: { kind: 'user' as const, userId },
  requestId: '10000000-0000-4000-8000-000000000005',
  idempotencyKey: 'open-chat-once',
  occurredAt: '2026-09-24T00:00:00.000Z',
  locale: 'en',
};

function capability(mustShowSafetyWarning: boolean): StoredChatCapability {
  return {
    chatSessionId,
    matchId,
    status: 'active' as const,
    canRead: true,
    canSendPredefined: true,
    canSendText: !mustShowSafetyWarning,
    canUnmatch: true,
    textUnlocked: true,
    mustShowSafetyWarning,
    muted: false,
    version: mustShowSafetyWarning ? 1 : 2,
  };
}

describe('M6 chat open handlers', () => {
  it('marks the warning only after presentation succeeds and returns a fresh action', async () => {
    const loadForMatch = vi.fn().mockResolvedValue(capability(true));
    const markSafetyWarningShown = vi.fn().mockResolvedValue(capability(false));
    const show = vi.fn().mockResolvedValue(undefined);
    const references = {
      resolveMatchAction: vi.fn().mockResolvedValue(matchId),
      resolveChatAction: vi.fn(),
      issueChatAction: vi.fn().mockResolvedValue(refreshedToken),
    };
    const handler = new OpenChatForMatchHandler(
      { loadForMatch, loadForSession: vi.fn(), markSafetyWarningShown },
      references,
      { show },
    );
    const result = await handler.execute({
      ...envelope,
      commandType: 'chat.open-for-match',
      data: { matchActionToken: matchToken },
    });
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ presentationId: envelope.commandId, chatSessionId }),
    );
    expect(markSafetyWarningShown).toHaveBeenCalledWith({
      userId,
      chatSessionId,
      expectedVersion: 1,
    });
    expect(result).toMatchObject({
      chatActionToken: refreshedToken,
      canSendText: true,
      mustShowSafetyWarning: false,
    });
  });

  it('leaves the warning pending when presentation fails', async () => {
    const markSafetyWarningShown = vi.fn();
    const handler = new OpenChatForMatchHandler(
      {
        loadForMatch: vi.fn().mockResolvedValue(capability(true)),
        loadForSession: vi.fn(),
        markSafetyWarningShown,
      },
      {
        resolveMatchAction: vi.fn().mockResolvedValue(matchId),
        resolveChatAction: vi.fn(),
        issueChatAction: vi.fn(),
      },
      { show: vi.fn().mockRejectedValue(new Error('presentation failed')) },
    );
    await expect(
      handler.execute({
        ...envelope,
        commandType: 'chat.open-for-match',
        data: { matchActionToken: matchToken },
      }),
    ).rejects.toThrow('presentation failed');
    expect(markSafetyWarningShown).not.toHaveBeenCalled();
  });

  it('reauthorizes a resolved chat and rotates its action token', async () => {
    const loadForSession = vi.fn().mockResolvedValue(capability(false));
    const references = {
      resolveMatchAction: vi.fn(),
      resolveChatAction: vi.fn().mockResolvedValue(chatSessionId),
      issueChatAction: vi.fn().mockResolvedValue(refreshedToken),
    };
    const handler = new GetChatCapabilityHandler(
      { loadForMatch: vi.fn(), loadForSession, markSafetyWarningShown: vi.fn() },
      references,
    );
    await expect(
      handler.execute({
        actor: envelope.actor,
        requestId: envelope.requestId,
        chatActionToken: chatToken,
      }),
    ).resolves.toMatchObject({ chatActionToken: refreshedToken, chatSessionId });
    expect(loadForSession).toHaveBeenCalledWith(userId, chatSessionId);
  });
});
