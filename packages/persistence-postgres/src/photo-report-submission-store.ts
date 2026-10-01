import {
  SubmitPhotoReportHandler,
  reportUnavailable,
  type PhotoReportSnapshotProtector,
  type ProfileReportWrite,
  type ReportTokens,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import {
  PostgresSingleEvidenceReportSubmissionStore,
  type SingleReportEvidenceCapture,
} from './profile-report-submission-store.js';
import { resolvePhotoReportSource } from './photo-report-source-store.js';
import { retainPhotoEvidenceInTransaction } from './photo-evidence-retention-store.js';

export async function capturePhotoReportEvidence(
  transaction: NakhDatabase,
  write: ProfileReportWrite,
  snapshots: PhotoReportSnapshotProtector,
): ReturnType<SingleReportEvidenceCapture['capture']> {
  const authorized = await resolvePhotoReportSource(
    transaction,
    write.actorUserId,
    write.intent.source,
    true,
  );
  if (
    authorized === undefined ||
    authorized.targetUserId !== write.intent.targetUserId ||
    write.intent.evidence.length !== 1 ||
    write.intent.evidence[0]?.evidenceType !== 'photo' ||
    authorized.evidence[0]?.referenceId !== write.intent.evidence[0].referenceId
  )
    throw reportUnavailable();
  const referenceId = authorized.evidence[0].referenceId;
  const content = await retainPhotoEvidenceInTransaction(transaction, {
    evidenceId: write.evidenceId,
    photoId: referenceId,
  });
  return {
    targetUserId: authorized.targetUserId,
    referenceId,
    snapshot: snapshots.protect(
      { reportId: write.reportId, evidenceId: write.evidenceId },
      content,
    ),
  };
}
export class PostgresPhotoReportSubmissionStore extends PostgresSingleEvidenceReportSubmissionStore {
  public constructor(database: NakhDatabase, snapshots: PhotoReportSnapshotProtector) {
    super(database, {
      capture: (transaction, write) => capturePhotoReportEvidence(transaction, write, snapshots),
    });
  }
}
export class PostgresSubmitPhotoReportHandler extends SubmitPhotoReportHandler {
  public constructor(
    database: NakhDatabase,
    tokens: ReportTokens,
    snapshots: PhotoReportSnapshotProtector,
  ) {
    super(
      tokens,
      new PostgresPhotoReportSubmissionStore(database, snapshots),
      new SystemIdGenerator(),
    );
  }
}
