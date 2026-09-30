import type { PrepareReportEvidenceQuery, PreparedReportEvidence } from '@nakh/contracts';
import { ApplicationError, type Actor } from '@nakh/domain';
import type { ReportEvidenceIntent, ReportSource, ReportTokens } from './report-tokens.js';

export interface ProfileReportSourceStore {
  resolve(actorUserId: string, source: ReportSource): Promise<ReportEvidenceIntent | undefined>;
}
export function reportUnavailable(): ApplicationError {
  return new ApplicationError('report_unavailable', 'error.report.unavailable', 409);
}
/** First supported evidence path; unsupported selections fail instead of silently dropping evidence. */
export class PrepareProfileReportEvidenceHandler {
  public constructor(
    private readonly tokens: Pick<ReportTokens, 'resolveSource' | 'issueIntent'>,
    private readonly store: ProfileReportSourceStore,
  ) {}
  public async execute(
    query: PrepareReportEvidenceQuery,
    actor: Actor,
  ): Promise<PreparedReportEvidence> {
    if (actor.kind !== 'user' || query.actor.kind !== 'user' || actor.userId !== query.actor.userId)
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    if (query.requestedEvidenceTypes.length !== 1 || query.requestedEvidenceTypes[0] !== 'profile')
      throw reportUnavailable();
    const source = await this.tokens.resolveSource(query.sourceActionToken, actor.userId);
    if (source === undefined) throw reportUnavailable();
    const intent = await this.store.resolve(actor.userId, source);
    if (
      intent === undefined ||
      intent.targetUserId === actor.userId ||
      intent.evidence.length !== 1 ||
      intent.evidence[0]?.evidenceType !== 'profile'
    )
      throw reportUnavailable();
    const issued = await this.tokens.issueIntent(actor.userId, intent);
    return {
      evidenceIntentToken: issued.token,
      evidenceTypes: ['profile'],
      expiresAt: issued.expiresAt,
    };
  }
}
