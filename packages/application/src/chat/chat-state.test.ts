import { describe, expect, it, vi } from 'vitest';

import { ChangeChatMuteHandler, GetChatPageHandler, MarkChatReadHandler } from './chat-state.js';

const userId = '10000000-0000-4000-8000-000000000001';
const chatSessionId = '10000000-0000-4000-8000-000000000002';
const requestId = '10000000-0000-4000-8000-000000000003';
const commandId = '10000000-0000-4000-8000-000000000004';
const eventId = '10000000-0000-4000-8000-000000000005';
const chatActionToken = `v1.ch.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const cursor = `v1.cm.${'c'.repeat(16)}.${'d'.repeat(16)}`;
const nextCursor = `v1.cm.${'e'.repeat(16)}.${'f'.repeat(16)}`;
const actor = { kind: 'user' as const, userId };
const envelope = {
  commandId,
  schemaVersion: 1 as const,
  actor,
  requestId,
  idempotencyKey: 'chat-state-once',
  occurredAt: '2026-09-24T00:00:00.000Z',
  locale: 'en',
};
const message = {
  messageId: '10000000-0000-4000-8000-000000000006',
  sequenceNumber: '9',
  sender: 'match' as const,
  messageType: 'text' as const,
  content: { text: 'hello' },
  createdAt: '2026-09-24T00:00:00.000Z',
};

describe('M6 chat page and participant state handlers', () => {
  it('binds page cursors to the resolved chat and issues the next opaque cursor', async () => {
    const readPage = vi.fn().mockResolvedValue({ items: [message], hasMore: true });
    const references = {
      resolveChatAction: vi.fn().mockResolvedValue(chatSessionId),
      resolveMessageCursor: vi.fn().mockResolvedValue({
        chatSessionId,
        beforeSequenceNumber: '10',
      }),
      issueMessageCursor: vi.fn().mockResolvedValue(nextCursor),
    };
    const handler = new GetChatPageHandler({ readPage }, references);
    await expect(
      handler.execute({ actor, requestId, chatActionToken, limit: 1, cursor }),
    ).resolves.toEqual({ items: [message], nextCursor });
    expect(readPage).toHaveBeenCalledWith({
      userId,
      chatSessionId,
      limit: 1,
      beforeSequenceNumber: '10',
    });
    expect(references.issueMessageCursor).toHaveBeenCalledWith(
      userId,
      { chatSessionId, beforeSequenceNumber: '9' },
      requestId,
    );
  });

  it('rejects a cursor bound to another chat before reading history', async () => {
    const readPage = vi.fn();
    const handler = new GetChatPageHandler(
      { readPage },
      {
        resolveChatAction: vi.fn().mockResolvedValue(chatSessionId),
        resolveMessageCursor: vi.fn().mockResolvedValue({
          chatSessionId: '10000000-0000-4000-8000-000000000099',
          beforeSequenceNumber: '10',
        }),
        issueMessageCursor: vi.fn(),
      },
    );
    await expect(
      handler.execute({ actor, requestId, chatActionToken, limit: 10, cursor }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(readPage).not.toHaveBeenCalled();
  });

  it('resolves actor-bound state commands and supplies opaque event identities', async () => {
    const markRead = vi.fn().mockResolvedValue({});
    const changeMute = vi.fn().mockResolvedValue({});
    const references = { resolveChatAction: vi.fn().mockResolvedValue(chatSessionId) };
    const ids = { uuid: vi.fn().mockReturnValue(eventId) };
    const store = { markRead, changeMute };
    await new MarkChatReadHandler(store, references, ids).execute({
      ...envelope,
      commandType: 'chat.mark-read',
      data: { chatActionToken, throughSequenceNumber: '9' },
    });
    await new ChangeChatMuteHandler(store, references, ids).execute({
      ...envelope,
      commandId: '10000000-0000-4000-8000-000000000007',
      idempotencyKey: 'chat-mute-once',
      commandType: 'chat.change-mute',
      data: { chatActionToken, muted: true, expectedVersion: 1 },
    });
    expect(markRead).toHaveBeenCalledWith(expect.objectContaining({ chatSessionId, eventId }));
    expect(changeMute).toHaveBeenCalledWith(expect.objectContaining({ chatSessionId, eventId }));
  });
});
