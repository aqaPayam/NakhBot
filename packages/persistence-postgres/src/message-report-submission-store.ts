import {
  SubmitMessageReportHandler,
  reportUnavailable,
  type ProfileReportWrite,
  type ReportTokens,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import {
  PostgresSingleEvidenceReportSubmissionStore,
  type SingleReportEvidenceCapture,
} from './profile-report-submission-store.js';
import { resolveMessageReportSource } from './message-report-source-store.js';
import { captureReportedMessagesInTransaction } from './chat-retention-store.js';

export async function captureMessageReportEvidence(
  transaction: NakhDatabase,
  write: ProfileReportWrite,
): ReturnType<SingleReportEvidenceCapture['capture']> {
  const authorized = await resolveMessageReportSource(
    transaction,
    write.actorUserId,
    write.intent.source,
    true,
  );
  if (
    authorized === undefined ||
    authorized.targetUserId !== write.intent.targetUserId ||
    write.intent.evidence.length !== 1 ||
    write.intent.evidence[0]?.evidenceType !== 'message' ||
    authorized.evidence[0]?.referenceId !== write.intent.evidence[0].referenceId
  )
    throw reportUnavailable();
  const referenceId = authorized.evidence[0].referenceId;
  const message = await transaction
    .selectFrom('chat.chat_messages')
    .select('chat_session_id')
    .where('id', '=', referenceId)
    .forShare()
    .executeTakeFirstOrThrow();
  return {
    targetUserId: authorized.targetUserId,
    referenceId,
    snapshot: {
      snapshotType: 'message',
      capture: async (tx) => {
        await captureReportedMessagesInTransaction(tx, {
          reportId: write.reportId,
          chatSessionId: message.chat_session_id,
          messageIds: [referenceId],
        });
      },
    },
  };
}
export class PostgresMessageReportSubmissionStore extends PostgresSingleEvidenceReportSubmissionStore {
  public constructor(database: NakhDatabase) {
    super(database, { capture: captureMessageReportEvidence });
  }
}
export class PostgresSubmitMessageReportHandler extends SubmitMessageReportHandler {
  public constructor(database: NakhDatabase, tokens: ReportTokens) {
    super(tokens, new PostgresMessageReportSubmissionStore(database), new SystemIdGenerator());
  }
}
