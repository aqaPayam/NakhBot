import { ApplicationError } from '@nakh/domain';

export type NakhMaintenancePhaseResult = Readonly<{
  examined: number;
  changed: number;
}>;

export type NakhMaintenanceBatchResult = Readonly<{
  pendingExpired: NakhMaintenancePhaseResult;
  deliveredExpired: NakhMaintenancePhaseResult;
  remindersSent: NakhMaintenancePhaseResult;
  hasMore: boolean;
}>;

export interface NakhMaintenanceStore {
  expirePending(limit: number): Promise<NakhMaintenancePhaseResult>;
  expireDelivered(limit: number): Promise<NakhMaintenancePhaseResult>;
  sendPendingReminders(limit: number): Promise<NakhMaintenancePhaseResult>;
}

/** Runs one bounded catch-up pass. Database deadlines remain authoritative. */
export class RunNakhMaintenanceBatchHandler {
  public constructor(private readonly store: NakhMaintenanceStore) {}

  public async execute(limit: number): Promise<NakhMaintenanceBatchResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250)
      throw new ApplicationError('invalid_request', 'error.nakh.maintenance_limit_invalid', 400);

    // Safety-sensitive terminal transitions win over optional reminders at the same tick.
    const pendingExpired = await this.store.expirePending(limit);
    const deliveredExpired = await this.store.expireDelivered(limit);
    const remindersSent = await this.store.sendPendingReminders(limit);
    return {
      pendingExpired,
      deliveredExpired,
      remindersSent,
      hasMore:
        pendingExpired.examined === limit ||
        deliveredExpired.examined === limit ||
        remindersSent.examined === limit,
    };
  }
}
