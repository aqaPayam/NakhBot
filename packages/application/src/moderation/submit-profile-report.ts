import { createHash } from 'node:crypto';
import type {
  ReportSubmissionResult,
  SubmitReportCommand,
  ReportEvidenceType,
} from '@nakh/contracts';
import { ApplicationError, normalizeReportText, type Actor, type IdGenerator } from '@nakh/domain';
import { reportUnavailable } from './prepare-profile-report.js';
import type { ReportEvidenceIntent, ReportTokens } from './report-tokens.js';

export type ProfileReportRequest = Readonly<{
  actorUserId: string;
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  requestDigest: string;
  reasonCode: string;
  normalizedText: string | undefined;
}>;
export type ProfileReportWrite = ProfileReportRequest &
  Readonly<{
    intent: ReportEvidenceIntent;
    reportId: string;
    evidenceId: string;
    snapshotId: string;
    reviewId: string;
    eventId: string;
  }>;
export interface ProfileReportSubmissionStore {
  replay(request: ProfileReportRequest): Promise<ReportSubmissionResult | undefined>;
  submit(write: ProfileReportWrite): Promise<ReportSubmissionResult>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export class SubmitSingleEvidenceReportHandler {
  private readonly evidenceTypes: readonly ReportEvidenceType[];
  public constructor(
    private readonly tokens: Pick<ReportTokens, 'resolveIntent'>,
    private readonly store: ProfileReportSubmissionStore,
    private readonly ids: IdGenerator,
    evidenceTypes: ReportEvidenceType | readonly ReportEvidenceType[],
  ) {
    this.evidenceTypes = typeof evidenceTypes === 'string' ? [evidenceTypes] : [...evidenceTypes];
  }
  public async execute(
    command: SubmitReportCommand,
    actor: Actor,
  ): Promise<ReportSubmissionResult> {
    if (
      actor.kind !== 'user' ||
      command.actor.kind !== 'user' ||
      actor.userId !== command.actor.userId
    )
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    if (
      command.commandType !== 'moderation.submit-report' ||
      command.schemaVersion !== 1 ||
      !UUID.test(command.commandId) ||
      !UUID.test(command.requestId) ||
      !UUID.test(actor.userId) ||
      !/^[a-z][a-z0-9_]{0,79}$/u.test(command.data.reasonCode) ||
      command.idempotencyKey.length < 8 ||
      command.idempotencyKey.length > 128
    )
      throw reportUnavailable();
    const normalizedText = normalizeReportText(command.data.text);
    // The immutable opaque intent binds its server-held source, target and ordered references.
    // Digesting the token permits durable replay after the short-lived cache entry is gone.
    const request: ProfileReportRequest = {
      actorUserId: actor.userId,
      commandId: command.commandId,
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      reasonCode: command.data.reasonCode,
      normalizedText,
      requestDigest: createHash('sha256')
        .update(
          JSON.stringify([
            'profile-report', // Retain the original namespace so existing durable receipts remain replayable.
            1,
            actor.userId,
            command.data.evidenceIntentToken,
            command.data.reasonCode,
            normalizedText ?? null,
          ]),
        )
        .digest('hex'),
    };
    const replay = await this.store.replay(request);
    if (replay !== undefined) return replay;
    const intent = await this.tokens.resolveIntent(command.data.evidenceIntentToken, actor.userId);
    if (
      intent === undefined ||
      intent.targetUserId === actor.userId ||
      intent.evidence.length !== 1 ||
      !this.evidenceTypes.some((type) => type === intent.evidence[0]?.evidenceType)
    )
      throw reportUnavailable();
    return this.store.submit({
      ...request,
      intent,
      reportId: this.ids.uuid(),
      evidenceId: this.ids.uuid(),
      snapshotId: this.ids.uuid(),
      reviewId: this.ids.uuid(),
      eventId: this.ids.uuid(),
    });
  }
}

export class SubmitProfileReportHandler extends SubmitSingleEvidenceReportHandler {
  public constructor(
    tokens: Pick<ReportTokens, 'resolveIntent'>,
    store: ProfileReportSubmissionStore,
    ids: IdGenerator,
  ) {
    super(tokens, store, ids, 'profile');
  }
}
export class SubmitChatReportHandler extends SubmitSingleEvidenceReportHandler {
  public constructor(
    tokens: Pick<ReportTokens, 'resolveIntent'>,
    store: ProfileReportSubmissionStore,
    ids: IdGenerator,
  ) {
    super(tokens, store, ids, 'chat');
  }
}
