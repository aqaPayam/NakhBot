import {
  SubmitSingleEvidenceReportHandler,
  reportUnavailable,
  type UnmatchedReportSnapshotProtector,
  type ProfileReportWrite,
  type ReportTokens,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import {
  PostgresSingleEvidenceReportSubmissionStore,
  type SingleReportEvidenceCapture,
} from './profile-report-submission-store.js';
import { resolveUnmatchedReportSource } from './unmatched-report-source-store.js';

export async function captureUnmatchedReportEvidence(
  transaction: NakhDatabase,
  write: ProfileReportWrite,
  snapshots: UnmatchedReportSnapshotProtector,
): ReturnType<SingleReportEvidenceCapture['capture']> {
  const authorized = await resolveUnmatchedReportSource(
    transaction,
    write.actorUserId,
    write.intent.source,
    true,
  );
  if (
    authorized === undefined ||
    authorized.targetUserId !== write.intent.targetUserId ||
    write.intent.evidence.length !== 1 ||
    write.intent.evidence[0]?.evidenceType !== 'unmatched_user' ||
    authorized.evidence[0]?.referenceId !== write.intent.evidence[0].referenceId
  )
    throw reportUnavailable();
  const row = await transaction
    .selectFrom('matching.unmatch_records')
    .select(['match_id', 'unmatched_at', 'report_window_expires_at'])
    .where('match_id', '=', authorized.evidence[0].referenceId)
    .executeTakeFirstOrThrow();
  return {
    targetUserId: authorized.targetUserId,
    referenceId: row.match_id,
    snapshot: snapshots.protect(
      { reportId: write.reportId, evidenceId: write.evidenceId },
      {
        evidenceType: 'unmatched_user',
        unmatchedAt: row.unmatched_at.toISOString(),
        reportWindowExpiresAt: row.report_window_expires_at.toISOString(),
      },
    ),
  };
}
export class PostgresUnmatchedReportSubmissionStore extends PostgresSingleEvidenceReportSubmissionStore {
  public constructor(database: NakhDatabase, snapshots: UnmatchedReportSnapshotProtector) {
    super(database, {
      capture: (transaction, write) =>
        captureUnmatchedReportEvidence(transaction, write, snapshots),
    });
  }
}
export class PostgresSubmitUnmatchedReportHandler extends SubmitSingleEvidenceReportHandler {
  public constructor(
    database: NakhDatabase,
    tokens: ReportTokens,
    snapshots: UnmatchedReportSnapshotProtector,
  ) {
    super(
      tokens,
      new PostgresUnmatchedReportSubmissionStore(database, snapshots),
      new SystemIdGenerator(),
      'unmatched_user',
    );
  }
}
