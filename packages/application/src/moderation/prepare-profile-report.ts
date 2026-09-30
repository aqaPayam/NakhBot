import type {
  PrepareReportEvidenceQuery,
  PreparedReportEvidence,
  ReportEvidenceType,
} from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { ReportEvidenceIntent, ReportSource, ReportTokens } from './report-tokens.js';

export interface ProfileReportSourceStore {
  resolve(actorUserId: string, source: ReportSource): Promise<ReportEvidenceIntent | undefined>;
}
export function reportUnavailable(): ApplicationError {
  return new ApplicationError('report_unavailable', 'error.report.unavailable', 409);
}
/** Shared one-evidence boundary; each owning source store performs authoritative authorization. */
export class PrepareSingleReportEvidenceHandler {
  public constructor(
    private readonly tokens: Pick<ReportTokens, 'resolveSource' | 'issueIntent'>,
    private readonly store: ProfileReportSourceStore,
    private readonly evidenceType: ReportEvidenceType,
  ) {}
  public async execute(
    query: PrepareReportEvidenceQuery,
    actor: Actor,
  ): Promise<PreparedReportEvidence> {
    if (actor.kind !== 'user' || query.actor.kind !== 'user' || actor.userId !== query.actor.userId)
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    if (
      query.requestedEvidenceTypes.length !== 1 ||
      query.requestedEvidenceTypes[0] !== this.evidenceType
    )
      throw reportUnavailable();
    const source = await this.tokens.resolveSource(query.sourceActionToken, actor.userId);
    if (source === undefined) throw reportUnavailable();
    const intent = await this.store.resolve(actor.userId, source);
    if (
      intent === undefined ||
      intent.targetUserId === actor.userId ||
      intent.evidence.length !== 1 ||
      intent.evidence[0]?.evidenceType !== this.evidenceType
    )
      throw reportUnavailable();
    const issued = await this.tokens.issueIntent(actor.userId, intent);
    return {
      evidenceIntentToken: issued.token,
      evidenceTypes: [this.evidenceType],
      expiresAt: issued.expiresAt,
    };
  }
}

export class PrepareProfileReportEvidenceHandler extends PrepareSingleReportEvidenceHandler {
  public constructor(
    tokens: Pick<ReportTokens, 'resolveSource' | 'issueIntent'>,
    store: ProfileReportSourceStore,
  ) {
    super(tokens, store, 'profile');
  }
}
export class PrepareChatReportEvidenceHandler extends PrepareSingleReportEvidenceHandler {
  public constructor(
    tokens: Pick<ReportTokens, 'resolveSource' | 'issueIntent'>,
    store: ProfileReportSourceStore,
  ) {
    super(tokens, store, 'chat');
  }
}
