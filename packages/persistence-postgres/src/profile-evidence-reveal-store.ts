import {
  authenticateReportEvidenceInTransaction,
  type ReportEvidenceReaders,
} from './report-capture-integrity.js';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
  ProfileReportSnapshotReader,
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
export type { ReportEvidenceReaders } from './report-capture-integrity.js';

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
    const result = await new PostgresAdminCommandStore(this.database).execute<
      RevealedReportEvidence['content']
    >(
      bound,
      async (transaction) => {
        if (
          attempt.commandCode !== 'moderation.reveal-evidence' ||
          attempt.requiredPermission !== 'view_reports' ||
          attempt.targetType !== 'report_evidence' ||
          attempt.expectedTargetVersion !== 1
        )
          throw new ApplicationError('invalid_request', 'error.moderation.invalid_request', 400);
        const content = await authenticateReportEvidenceInTransaction(
          transaction,
          this.readers,
          attempt.targetId,
        );
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
