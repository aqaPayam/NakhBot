import { sql } from 'kysely';
import {
  EvaluateModerationThresholdHandler,
  SubmitProfileReportHandler,
  reportUnavailable,
  type ProfileReportSnapshotProtector,
  type ProtectedProfileReportSnapshot,
  type ProtectedChatReportSnapshot,
  type ProfileReportRequest,
  type ProfileReportWrite,
  type ProfileReportSubmissionStore,
  type ReportTokens,
} from '@nakh/application';
import type { ReportSubmissionResult } from '@nakh/contracts';
import { ApplicationError, canSubmitUserReport } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import { resolveProfileReportSource } from './profile-report-source-store.js';
import { applyModerationThreshold } from './moderation-threshold-store.js';

async function replay(
  database: NakhDatabase,
  request: ProfileReportRequest,
): Promise<ReportSubmissionResult | undefined> {
  const rows = await database
    .selectFrom('moderation.reports')
    .select(['id', 'reporter_user_id', 'request_digest', 'submitted_at'])
    .where((eb) =>
      eb.or([
        eb('command_id', '=', request.commandId),
        eb.and([
          eb('reporter_user_id', '=', request.actorUserId),
          eb('idempotency_key', '=', request.idempotencyKey),
        ]),
      ]),
    )
    .execute();
  if (rows.length === 0) return undefined;
  const row = rows[0]!;
  if (
    rows.length !== 1 ||
    row.reporter_user_id !== request.actorUserId ||
    row.request_digest !== request.requestDigest
  )
    throw new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
  // Replay the submission receipt, never expose a later confidential review outcome.
  return {
    reportId: row.id,
    status: 'pending_review',
    submittedAt: row.submitted_at.toISOString(),
    replayed: true,
  };
}
export interface SingleReportEvidenceCapture {
  capture(
    transaction: NakhDatabase,
    write: ProfileReportWrite,
  ): Promise<
    Readonly<{
      targetUserId: string;
      referenceId: string;
      snapshot: ProtectedProfileReportSnapshot | ProtectedChatReportSnapshot;
    }>
  >;
}

export class PostgresSingleEvidenceReportSubmissionStore implements ProfileReportSubmissionStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly capture: SingleReportEvidenceCapture,
  ) {}
  public replay(request: ProfileReportRequest): Promise<ReportSubmissionResult | undefined> {
    return replay(this.database, request);
  }
  public submit(write: ProfileReportWrite): Promise<ReportSubmissionResult> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('report-command:' || ${write.commandId}::text, 0))`.execute(
        transaction,
      );
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-report:' || ${write.actorUserId}::text, 0))`.execute(
        transaction,
      );
      const previous = await replay(transaction, write);
      if (previous !== undefined) return previous;
      const count = await transaction
        .selectFrom('moderation.reports')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('reporter_user_id', '=', write.actorUserId)
        .where('submitted_at', '>', sql<Date>`transaction_timestamp() - interval '24 hours'`)
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= 10)
        throw new ApplicationError('report_limit_reached', 'error.m7.rate_limited', 429);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-threshold:' || ${write.intent.targetUserId}::text, 0))`.execute(
        transaction,
      );
      // Lock both accounts in canonical order so reciprocal reports cannot deadlock.
      const accounts = await transaction
        .selectFrom('identity.accounts')
        .select(['user_id', 'state'])
        .where('user_id', 'in', [write.actorUserId, write.intent.targetUserId])
        .orderBy('user_id')
        .forUpdate()
        .execute();
      const reporter = accounts.find((row) => row.user_id === write.actorUserId);
      if (accounts.length !== 2 || reporter === undefined || !canSubmitUserReport(reporter.state))
        throw reportUnavailable();
      const captured = await this.capture.capture(transaction, write);
      if (
        captured.targetUserId !== write.intent.targetUserId ||
        write.intent.evidence.length !== 1 ||
        captured.snapshot.snapshotType !== write.intent.evidence[0]?.evidenceType ||
        captured.referenceId !== write.intent.evidence[0].referenceId
      )
        throw reportUnavailable();
      const snapshot = captured.snapshot;
      const reason = await transaction
        .selectFrom('moderation.report_reasons')
        .select('id')
        .where('code', '=', write.reasonCode)
        .where('is_active', '=', true)
        .forShare()
        .executeTakeFirst();
      if (reason === undefined) throw reportUnavailable();
      const report = await transaction
        .insertInto('moderation.reports')
        .values({
          id: write.reportId,
          reporter_user_id: write.actorUserId,
          target_user_id: captured.targetUserId,
          reason_id: reason.id,
          extra_text: write.normalizedText ?? null,
          status: 'pending_review',
          command_id: write.commandId,
          request_id: write.requestId,
          idempotency_key: write.idempotencyKey,
          request_digest: write.requestDigest,
          reviewed_at: null,
          closed_at: null,
        })
        .returning('submitted_at')
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('moderation.report_evidence')
        .values({
          id: write.evidenceId,
          report_id: write.reportId,
          evidence_type: snapshot.snapshotType,
          profile_id: snapshot.snapshotType === 'profile' ? captured.referenceId : null,
          profile_photo_id: null,
          chat_session_id: snapshot.snapshotType === 'chat' ? captured.referenceId : null,
          chat_message_id: null,
          unmatch_record_id: null,
        })
        .execute();
      await transaction
        .insertInto('moderation.report_snapshots')
        .values({
          id: write.snapshotId,
          report_id: write.reportId,
          report_evidence_id: write.evidenceId,
          snapshot_type: snapshot.snapshotType,
          schema_version: snapshot.schemaVersion,
          encryption_key_id: snapshot.keyId,
          encryption_key_version: snapshot.keyVersion,
          nonce: Buffer.from(snapshot.nonce),
          ciphertext: Buffer.from(snapshot.ciphertext),
          content_sha256: snapshot.sha256,
        })
        .execute();
      await transaction
        .insertInto('moderation.moderation_reviews')
        .values({
          id: write.reviewId,
          report_id: write.reportId,
          assigned_admin_id: null,
          assigned_at: null,
          decided_at: null,
          decision_note_ciphertext: null,
          decision_note_key_id: null,
          decision_note_key_version: null,
          decision_note_nonce: null,
          decision_note_sha256: null,
          created_at: sql<Date>`transaction_timestamp()`,
          updated_at: sql<Date>`transaction_timestamp()`,
        })
        .execute();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: write.eventId,
          aggregate_type: 'report',
          aggregate_id: write.reportId,
          event_type: 'moderation.report-submitted.v1',
          schema_version: 1,
          payload: {
            reportId: write.reportId,
            evidenceTypes: [snapshot.snapshotType],
            status: 'pending_review',
          },
          occurred_at: report.submitted_at,
          available_at: report.submitted_at,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: write.requestId,
          causation_id: write.commandId,
        })
        .execute();
      await new EvaluateModerationThresholdHandler(
        { evaluate: (threshold) => applyModerationThreshold(transaction, threshold) },
        new SystemIdGenerator(),
      ).execute({
        sourceReportId: write.reportId,
        requestId: write.requestId,
        commandId: write.commandId,
      });
      return {
        reportId: write.reportId,
        status: 'pending_review',
        submittedAt: report.submitted_at.toISOString(),
        replayed: false,
      };
    });
  }
}

export async function captureProfileReportEvidence(
  transaction: NakhDatabase,
  write: ProfileReportWrite,
  snapshots: ProfileReportSnapshotProtector,
): ReturnType<SingleReportEvidenceCapture['capture']> {
  const authorized = await resolveProfileReportSource(
    transaction,
    write.actorUserId,
    write.intent.source,
    true,
  );
  if (
    authorized === undefined ||
    authorized.targetUserId !== write.intent.targetUserId ||
    write.intent.evidence.length !== 1 ||
    write.intent.evidence[0]?.evidenceType !== 'profile' ||
    authorized.evidence[0]?.referenceId !== write.intent.evidence[0].referenceId
  )
    throw reportUnavailable();
  const profile = await transaction
    .selectFrom('profile.profiles')
    .select(['name', 'birth_year', 'bio'])
    .where('id', '=', authorized.evidence[0].referenceId)
    .forShare()
    .executeTakeFirstOrThrow();
  return {
    targetUserId: authorized.targetUserId,
    referenceId: authorized.evidence[0].referenceId,
    snapshot: snapshots.protect(
      { reportId: write.reportId, evidenceId: write.evidenceId },
      {
        evidenceType: 'profile',
        displayName: profile.name,
        birthYear: profile.birth_year,
        ...(profile.bio === null ? {} : { bio: profile.bio }),
      },
    ),
  };
}
export class PostgresProfileReportSubmissionStore extends PostgresSingleEvidenceReportSubmissionStore {
  public constructor(database: NakhDatabase, snapshots: ProfileReportSnapshotProtector) {
    super(database, {
      capture: (transaction, write) => captureProfileReportEvidence(transaction, write, snapshots),
    });
  }
}
export class PostgresSubmitProfileReportHandler extends SubmitProfileReportHandler {
  public constructor(
    database: NakhDatabase,
    tokens: ReportTokens,
    snapshots: ProfileReportSnapshotProtector,
  ) {
    super(
      tokens,
      new PostgresProfileReportSubmissionStore(database, snapshots),
      new SystemIdGenerator(),
    );
  }
}
