import type { RevealReportEvidenceCommand, RevealedReportEvidence } from '@nakh/contracts';
import type { Actor } from '@nakh/domain';
import type {
  ConfirmationScope,
  ConfirmedAdminCommandBoundary,
} from '../administration/confirmed-command.js';
import type {
  AdminCommandAttempt,
  AdminCommandExecutionResult,
} from '../administration/admin-command.js';

export type EvidenceRevealDraft = Omit<RevealReportEvidenceCommand, 'data'> & {
  data: Omit<RevealReportEvidenceCommand['data'], 'confirmationToken'>;
};
export interface EvidenceRevealStore {
  reveal(
    attempt: AdminCommandAttempt,
  ): Promise<AdminCommandExecutionResult<RevealedReportEvidence>>;
}
function scope(command: EvidenceRevealDraft): ConfirmationScope {
  return {
    permission: 'view_reports' as const,
    targetType: 'report_evidence',
    payload: [command.data.evidenceId],
  };
}
export class ConfirmedEvidenceReveals {
  public constructor(
    private readonly boundary: ConfirmedAdminCommandBoundary,
    private readonly store: EvidenceRevealStore,
  ) {}
  public prepare(command: EvidenceRevealDraft, actor: Actor): Promise<string> {
    // Evidence and its snapshot are immutable; no client-controlled version is needed.
    return this.boundary.prepare(
      { ...command, data: { ...command.data, expectedTargetVersion: 1 } },
      actor,
      scope(command),
    );
  }
  public async execute(
    command: RevealReportEvidenceCommand,
    actor: Actor,
  ): Promise<AdminCommandExecutionResult<RevealedReportEvidence>> {
    const { attempt, action } = await this.boundary.resolve(
      { ...command, data: { ...command.data, expectedTargetVersion: 1 } },
      actor,
      scope(command),
    );
    return this.store.reveal(
      action.targetId === command.data.evidenceId
        ? attempt
        : {
            ...attempt,
            preconditionRejection: 'invalid_request',
          },
    );
  }
}
