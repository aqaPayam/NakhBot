import { ApplicationError, type IdGenerator, type ThresholdOutcome } from '@nakh/domain';

export type ModerationThresholdResult = Readonly<{
  sourceReportId: string;
  targetUserId: string;
  distinctReporterCount: number;
  outcome: ThresholdOutcome;
  accountVersion: number;
  restrictionEpisodeId?: string;
}>;

export type ModerationThresholdWrite = Readonly<{
  sourceReportId: string;
  requestId: string;
  commandId: string;
  restrictionEpisodeId: string;
  reviewId: string;
  actionId: string;
  auditId: string;
  accountHistoryId: string;
  notificationId: string;
  notificationDeliveryId: string;
  notificationDeliveryEventId: string;
  accountEventId: string;
  thresholdEventId: string;
  actionEventId: string;
}>;

export interface ModerationThresholdStore {
  evaluate(write: ModerationThresholdWrite): Promise<ModerationThresholdResult>;
}

/** Internal coordinator used by Report submission after evidence has been persisted. */
export class EvaluateModerationThresholdHandler {
  public constructor(
    private readonly store: ModerationThresholdStore,
    private readonly ids: IdGenerator,
  ) {}

  public execute(
    input: Readonly<{
      sourceReportId: string;
      requestId: string;
      commandId: string;
    }>,
  ): Promise<ModerationThresholdResult> {
    if (
      input.sourceReportId.length === 0 ||
      input.requestId.length === 0 ||
      input.commandId.length === 0
    )
      throw new ApplicationError(
        'invalid_request',
        'error.moderation.threshold_request_invalid',
        400,
      );
    return this.store.evaluate({
      ...input,
      restrictionEpisodeId: this.ids.uuid(),
      reviewId: this.ids.uuid(),
      actionId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      accountHistoryId: this.ids.uuid(),
      notificationId: this.ids.uuid(),
      notificationDeliveryId: this.ids.uuid(),
      notificationDeliveryEventId: this.ids.uuid(),
      accountEventId: this.ids.uuid(),
      thresholdEventId: this.ids.uuid(),
      actionEventId: this.ids.uuid(),
    });
  }
}
