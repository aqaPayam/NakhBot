import type { CaptureReportedMessagesCommand, CleanupChatCommand } from '@nakh/contracts';
import { ApplicationError, type Clock, type IdGenerator } from '@nakh/domain';

export type CaptureReportedMessagesResult = Readonly<{
  reportId: string;
  chatSessionId: string;
  capturedMessageIds: readonly string[];
  replayed: boolean;
}>;

export type CleanupChatResult = Readonly<{
  chatSessionId: string;
  retainedCount: number;
  snapshotCount: number;
  deletedCount: number;
  hasMore: boolean;
}>;

export interface ChatRetentionStore {
  captureReportedMessages(
    command: CaptureReportedMessagesCommand,
  ): Promise<CaptureReportedMessagesResult>;
  cleanupChat(command: CleanupChatCommand): Promise<CleanupChatResult>;
  findCleanupCandidates(limit: number): Promise<readonly string[]>;
}

function requireSystem(actor: CaptureReportedMessagesCommand['actor']): void {
  if (actor.kind !== 'system')
    throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}

export class CaptureReportedMessagesHandler {
  public constructor(private readonly store: ChatRetentionStore) {}

  public async execute(
    command: CaptureReportedMessagesCommand,
  ): Promise<CaptureReportedMessagesResult> {
    requireSystem(command.actor);
    return await this.store.captureReportedMessages(command);
  }
}

export class CleanupChatHandler {
  public constructor(private readonly store: ChatRetentionStore) {}

  public async execute(command: CleanupChatCommand): Promise<CleanupChatResult> {
    requireSystem(command.actor);
    return await this.store.cleanupChat(command);
  }
}

export type ChatCleanupBatchResult = Readonly<{
  examinedCount: number;
  deletedCount: number;
  snapshotCount: number;
  hasMore: boolean;
}>;

/** Bounded scheduler use case; every session cleanup remains independently transactional. */
export class RunChatCleanupBatchHandler {
  public constructor(
    private readonly store: ChatRetentionStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(limit: number): Promise<ChatCleanupBatchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApplicationError('invalid_request', 'error.chat.cleanup_batch_invalid', 400);
    const candidates = await this.store.findCleanupCandidates(limit);
    let deletedCount = 0;
    let snapshotCount = 0;
    let sessionHasMore = false;
    for (const chatSessionId of candidates) {
      const commandId = this.ids.uuid();
      const result = await this.store.cleanupChat({
        commandId,
        commandType: 'chat.cleanup',
        schemaVersion: 1,
        actor: { kind: 'system', userId: '00000000-0000-4000-8000-000000000001' },
        requestId: this.ids.uuid(),
        idempotencyKey: `chat-cleanup:${commandId}`,
        occurredAt: this.clock.now().toISOString(),
        locale: 'en',
        data: { chatSessionId, deleteBatchSize: 100 },
      });
      deletedCount += result.deletedCount;
      snapshotCount += result.snapshotCount;
      sessionHasMore ||= result.hasMore;
    }
    return {
      examinedCount: candidates.length,
      deletedCount,
      snapshotCount,
      hasMore: sessionHasMore || candidates.length === limit,
    };
  }
}
