import {
  SubmitChatReportHandler,
  reportUnavailable,
  type ChatReportSnapshotProtector,
  type ProfileReportWrite,
  type ReportTokens,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import {
  PostgresSingleEvidenceReportSubmissionStore,
  type SingleReportEvidenceCapture,
} from './profile-report-submission-store.js';
import { resolveChatReportSource } from './chat-report-source-store.js';

export async function captureChatReportEvidence(
  transaction: NakhDatabase,
  write: ProfileReportWrite,
  snapshots: ChatReportSnapshotProtector,
): ReturnType<SingleReportEvidenceCapture['capture']> {
  const authorized = await resolveChatReportSource(
    transaction,
    write.actorUserId,
    write.intent.source,
    true,
  );
  if (
    authorized === undefined ||
    authorized.targetUserId !== write.intent.targetUserId ||
    write.intent.evidence.length !== 1 ||
    write.intent.evidence[0]?.evidenceType !== 'chat' ||
    authorized.evidence[0]?.referenceId !== write.intent.evidence[0].referenceId
  )
    throw reportUnavailable();
  const session = await transaction
    .selectFrom('chat.chat_sessions')
    .select(['id', 'status', 'closed_at'])
    .where('id', '=', authorized.evidence[0].referenceId)
    .forShare()
    .executeTakeFirstOrThrow();
  if (session.status !== 'active' || session.closed_at !== null) throw reportUnavailable();
  return {
    targetUserId: authorized.targetUserId,
    referenceId: session.id,
    snapshot: snapshots.protect(
      { reportId: write.reportId, evidenceId: write.evidenceId },
      { evidenceType: 'chat', chatSessionId: session.id, status: 'active' },
    ),
  };
}
export class PostgresChatReportSubmissionStore extends PostgresSingleEvidenceReportSubmissionStore {
  public constructor(database: NakhDatabase, snapshots: ChatReportSnapshotProtector) {
    super(database, {
      capture: (transaction, write) => captureChatReportEvidence(transaction, write, snapshots),
    });
  }
}
export class PostgresSubmitChatReportHandler extends SubmitChatReportHandler {
  public constructor(
    database: NakhDatabase,
    tokens: ReportTokens,
    snapshots: ChatReportSnapshotProtector,
  ) {
    super(
      tokens,
      new PostgresChatReportSubmissionStore(database, snapshots),
      new SystemIdGenerator(),
    );
  }
}
