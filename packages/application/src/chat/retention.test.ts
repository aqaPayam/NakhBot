import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  CaptureReportedMessagesHandler,
  CleanupChatHandler,
  RunChatCleanupBatchHandler,
  type ChatRetentionStore,
} from './retention.js';

const reportId = '10000000-0000-4000-8000-000000000001';
const chatSessionId = '10000000-0000-4000-8000-000000000002';
const messageId = '10000000-0000-4000-8000-000000000003';
const systemActor = { kind: 'system' as const, userId: '10000000-0000-4000-8000-000000000004' };
const envelope = {
  commandId: '10000000-0000-4000-8000-000000000005',
  schemaVersion: 1 as const,
  actor: systemActor,
  requestId: '10000000-0000-4000-8000-000000000006',
  idempotencyKey: 'chat-retention-once',
  occurredAt: '2026-09-24T00:00:00.000Z',
  locale: 'en',
};

type StoreMock = Readonly<{
  captureReportedMessages: Mock<ChatRetentionStore['captureReportedMessages']>;
  cleanupChat: Mock<ChatRetentionStore['cleanupChat']>;
  findCleanupCandidates: Mock<ChatRetentionStore['findCleanupCandidates']>;
}>;

function store(): StoreMock {
  return {
    captureReportedMessages: vi
      .fn<ChatRetentionStore['captureReportedMessages']>()
      .mockResolvedValue({
        reportId,
        chatSessionId,
        capturedMessageIds: [messageId],
        replayed: false,
      }),
    cleanupChat: vi.fn<ChatRetentionStore['cleanupChat']>().mockResolvedValue({
      chatSessionId,
      retainedCount: 50,
      snapshotCount: 1,
      deletedCount: 5,
      hasMore: false,
    }),
    findCleanupCandidates: vi
      .fn<ChatRetentionStore['findCleanupCandidates']>()
      .mockResolvedValue([chatSessionId]),
  };
}

describe('M6 chat retention handlers', () => {
  it('allows only the internal system port to capture report evidence', async () => {
    const persistence = store();
    const handler = new CaptureReportedMessagesHandler(persistence);
    const command = {
      ...envelope,
      commandType: 'chat.capture-reported-messages' as const,
      data: { reportId, chatSessionId, messageIds: [messageId] },
    };
    await expect(handler.execute(command)).resolves.toMatchObject({ replayed: false });
    await expect(
      handler.execute({ ...command, actor: { kind: 'user', userId: systemActor.userId } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(persistence.captureReportedMessages).toHaveBeenCalledOnce();
  });

  it('rejects user-driven cleanup and aggregates bounded scheduler work', async () => {
    const persistence = store();
    const cleanup = new CleanupChatHandler(persistence);
    const command = {
      ...envelope,
      commandType: 'chat.cleanup' as const,
      data: { chatSessionId, deleteBatchSize: 100 },
    };
    await expect(
      cleanup.execute({ ...command, actor: { kind: 'user', userId: systemActor.userId } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const batch = new RunChatCleanupBatchHandler(
      persistence,
      { uuid: () => envelope.commandId },
      { now: () => new Date(envelope.occurredAt) },
    );
    await expect(batch.execute(10)).resolves.toEqual({
      examinedCount: 1,
      deletedCount: 5,
      snapshotCount: 1,
      hasMore: false,
    });
  });
});
