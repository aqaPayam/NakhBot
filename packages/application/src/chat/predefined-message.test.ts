import { describe, expect, it, vi } from 'vitest';

import {
  SendPredefinedAnswerHandler,
  SendPredefinedQuestionHandler,
} from './predefined-message.js';

const userId = '10000000-0000-4000-8000-000000000000';
const chatSessionId = '20000000-0000-4000-8000-000000000000';
const questionId = '30000000-0000-4000-8000-000000000000';
const answerId = '40000000-0000-4000-8000-000000000000';
const token = `v1.ch.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const ids = { uuid: vi.fn(() => '50000000-0000-4000-8000-000000000000') };

const envelope = {
  commandId: '60000000-0000-4000-8000-000000000000',
  schemaVersion: 1 as const,
  actor: { kind: 'user' as const, userId },
  requestId: '70000000-0000-4000-8000-000000000000',
  idempotencyKey: 'chat-message:test',
  occurredAt: '2026-09-24T00:00:00.000Z',
  locale: 'en',
};

describe('M6 predefined chat handlers', () => {
  it('resolves an actor-bound chat and sends a generated question transaction', async () => {
    const result = {
      message: {
        messageId: ids.uuid(),
        sequenceNumber: '1',
        sender: 'self' as const,
        messageType: 'predefined_question' as const,
        content: { questionId, textKey: 'chat.prompt.relationship_intent.question' },
        createdAt: envelope.occurredAt,
      },
      replayed: false,
    };
    const sendPredefined = vi.fn().mockResolvedValue(result);
    const resolveChatAction = vi.fn().mockResolvedValue(chatSessionId);
    const command = {
      ...envelope,
      commandType: 'chat.send-predefined-question' as const,
      data: { chatActionToken: token, questionId },
    };
    const handler = new SendPredefinedQuestionHandler(
      { sendPredefined },
      { resolveChatAction },
      ids,
    );
    await expect(handler.execute(command)).resolves.toEqual(result);
    expect(resolveChatAction).toHaveBeenCalledWith(token, userId);
    expect(sendPredefined).toHaveBeenCalledWith(
      expect.objectContaining({ command, chatSessionId }),
    );
  });

  it('forwards a valid answer pair and rejects unresolved or non-user actions', async () => {
    const sendPredefined = vi.fn().mockResolvedValue({});
    const references = { resolveChatAction: vi.fn().mockResolvedValue(chatSessionId) };
    const handler = new SendPredefinedAnswerHandler({ sendPredefined }, references, ids);
    const command = {
      ...envelope,
      commandType: 'chat.send-predefined-answer' as const,
      data: { chatActionToken: token, questionId, answerId },
    };
    await handler.execute(command);
    expect(sendPredefined).toHaveBeenCalledWith(
      expect.objectContaining({ command, chatSessionId }),
    );

    references.resolveChatAction.mockResolvedValueOnce(undefined);
    await expect(handler.execute(command)).rejects.toMatchObject({ code: 'chat_unavailable' });
    await expect(
      handler.execute({ ...command, actor: { kind: 'system', userId } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
