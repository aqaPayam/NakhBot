import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  ProfileReportSnapshotReader,
  ChatReportSnapshotReader,
  UnmatchedReportSnapshotReader,
  PhotoReportSnapshotReader,
} from '@nakh/application';
import type { RevealedReportEvidence } from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import {
  PostgresAdminCommandStore,
  recordEvidenceAccessInTransaction,
} from './admin-command-store.js';
import { SystemIdGenerator } from './foundation-store.js';

/** Internal capability: callers must recover attempts through the confirmed admin boundary. */
export type ReportEvidenceReaders = Readonly<{
  profile?: ProfileReportSnapshotReader;
  chat?: ChatReportSnapshotReader;
  unmatched_user?: UnmatchedReportSnapshotReader;
  photo?: PhotoReportSnapshotReader;
}>;
export class PostgresReportEvidenceRevealStore {
  public constructor(
    private readonly database: NakhDatabase,
    private readonly readers: ReportEvidenceReaders,
    private readonly ids: IdGenerator = new SystemIdGenerator(),
  ) {}

  public async reveal(
    attempt: AdminCommandAttempt,
  ): Promise<AdminCommandExecutionResult<RevealedReportEvidence>> {
    const auditId = this.ids.uuid();
    const bound = { ...attempt, metadata: {} };
    const result = await new PostgresAdminCommandStore(this.database).execute(
      bound,
      async (transaction) => {
        if (
          attempt.commandCode !== 'moderation.reveal-evidence' ||
          attempt.requiredPermission !== 'view_reports' ||
          attempt.targetType !== 'report_evidence' ||
          attempt.expectedTargetVersion !== 1
        )
          throw new ApplicationError('invalid_request', 'error.moderation.invalid_request', 400);
        const row = await transaction
          .selectFrom('moderation.report_evidence as evidence')
          .innerJoin(
            'moderation.report_snapshots as snapshot',
            'snapshot.report_evidence_id',
            'evidence.id',
          )
          .select([
            'evidence.report_id',
            'evidence.evidence_type',
            'evidence.chat_session_id',
            'evidence.unmatch_record_id',
            'evidence.profile_photo_id',
            'snapshot.snapshot_type',
            'snapshot.schema_version',
            'snapshot.encryption_key_id',
            'snapshot.encryption_key_version',
            'snapshot.nonce',
            'snapshot.ciphertext',
            'snapshot.content_sha256',
          ])
          .where('evidence.id', '=', attempt.targetId)
          .executeTakeFirst();
        const reader =
          row?.evidence_type === 'profile'
            ? this.readers.profile
            : row?.evidence_type === 'chat'
              ? this.readers.chat
              : row?.evidence_type === 'unmatched_user'
                ? this.readers.unmatched_user
                : row?.evidence_type === 'photo'
                  ? this.readers.photo
                  : undefined;
        if (row === undefined || reader === undefined)
          throw new ApplicationError(
            'report_unavailable',
            'error.moderation.report_unavailable',
            409,
          );
        const content = reader.decrypt(
          { reportId: row.report_id, evidenceId: attempt.targetId },
          {
            snapshotType: row.snapshot_type,
            schemaVersion: row.schema_version,
            keyId: row.encryption_key_id,
            keyVersion: row.encryption_key_version,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            sha256: row.content_sha256,
          },
        );
        if (
          content.evidenceType !== row.evidence_type ||
          (content.evidenceType === 'chat' && content.chatSessionId !== row.chat_session_id)
        )
          throw new Error('Report snapshot reference is invalid.');
        if (content.evidenceType === 'unmatched_user') {
          const source =
            row.unmatch_record_id === null
              ? undefined
              : await transaction
                  .selectFrom('matching.unmatch_records')
                  .select(['unmatched_at', 'report_window_expires_at'])
                  .where('match_id', '=', row.unmatch_record_id)
                  .executeTakeFirst();
          // Retained evidence remains reviewable after expiry; only its immutable binding matters.
          if (
            source === undefined ||
            content.unmatchedAt !== source.unmatched_at.toISOString() ||
            content.reportWindowExpiresAt !== source.report_window_expires_at.toISOString()
          )
            throw new Error('Report snapshot reference is invalid.');
        }
        if (content.evidenceType === 'photo') {
          const held = await transaction
            .selectFrom('media.report_photo_evidence_holds as hold')
            .innerJoin('media.photo_variants as variant', 'variant.id', 'hold.variant_id')
            .select([
              'hold.photo_id',
              'hold.content_sha256',
              'hold.captured_primary',
              'variant.storage_deleted_at',
            ])
            .where('hold.report_evidence_id', '=', attempt.targetId)
            .executeTakeFirst();
          if (
            held === undefined ||
            held.photo_id !== row.profile_photo_id ||
            held.storage_deleted_at !== null ||
            content.evidenceObjectRef !== `v1.pe.${attempt.targetId}` ||
            content.contentSha256 !== held.content_sha256 ||
            content.primary !== held.captured_primary
          )
            throw new Error('Report snapshot reference is invalid.');
        }
        return { safeCode: 'evidence_revealed', value: content };
      },
      async (transaction, outcome) => {
        // Unknown IDs have no FK-valid evidence row; their sanitized admin attempt still commits.
        const evidence = await transaction
          .selectFrom('moderation.report_evidence')
          .select('report_id')
          .where('id', '=', attempt.targetId)
          .executeTakeFirst();
        if (evidence === undefined) return;
        await recordEvidenceAccessInTransaction(transaction, {
          auditId,
          reportId: evidence.report_id,
          reportEvidenceId: attempt.targetId,
          adminUserId: attempt.adminUserId,
          commandId: attempt.commandId,
          requestId: attempt.requestId,
          reasonCode: 'report_evidence_review',
          permissionCode: 'view_reports',
          outcome: outcome.result === 'succeeded' ? 'revealed' : 'rejected',
          safeCode: outcome.safeCode,
        });
      },
    );
    // The transaction promise resolves only after COMMIT. Never reload plaintext on replay.
    return {
      ...result,
      value:
        result.value === undefined
          ? undefined
          : {
              evidenceId: attempt.targetId,
              snapshotSchemaVersion: 1,
              content: result.value,
              accessedAt: result.recordedAt.toISOString(),
            },
    };
  }
}

export class PostgresProfileEvidenceRevealStore extends PostgresReportEvidenceRevealStore {
  public constructor(
    database: NakhDatabase,
    snapshots: ProfileReportSnapshotReader,
    ids?: IdGenerator,
  ) {
    super(database, { profile: snapshots }, ids);
  }
}
