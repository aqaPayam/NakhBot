import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';

export type ModerationOperationalHealth = Readonly<{
  oldestPendingReportAgeSeconds: number;
  oldestInReviewAgeSeconds: number;
  activeReconciliationAgeSeconds: number;
  completedReconciliationAgeSeconds: number;
  reconciliationNeverCompleted: number;
}>;

/** Aggregate liveness, not a claim that retained quarantines are current integrity drift.
 * No report, appeal, workforce identity, content, token or cursor is selected. */
export class PostgresModerationOperationalMetricsStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async measure(): Promise<ModerationOperationalHealth> {
    const row = (
      await sql<Record<keyof ModerationOperationalHealth, string>>`
      SELECT
        COALESCE(greatest(0, extract(epoch FROM clock_timestamp() - (
          SELECT submitted_at FROM moderation.reports WHERE status IN ('submitted','pending_review')
          ORDER BY submitted_at, id LIMIT 1))), 0)::text AS "oldestPendingReportAgeSeconds",
        COALESCE(greatest(0, extract(epoch FROM clock_timestamp() - (
          SELECT updated_at FROM moderation.moderation_reviews WHERE status = 'in_review'
          ORDER BY updated_at, id LIMIT 1))), 0)::text AS "oldestInReviewAgeSeconds",
        COALESCE(greatest(0, extract(epoch FROM clock_timestamp() - (
          SELECT started_at FROM billing.reconciliation_runs WHERE run_type = 'moderation' AND status = 'started'
          ORDER BY started_at, id LIMIT 1))), 0)::text AS "activeReconciliationAgeSeconds",
        COALESCE(greatest(0, extract(epoch FROM clock_timestamp() - (
          SELECT finished_at FROM billing.reconciliation_runs WHERE run_type = 'moderation' AND status = 'succeeded'
          ORDER BY finished_at DESC, id DESC LIMIT 1))), 0)::text AS "completedReconciliationAgeSeconds",
        CASE WHEN EXISTS (SELECT 1 FROM billing.reconciliation_runs
          WHERE run_type = 'moderation' AND status = 'succeeded') THEN '0' ELSE '1' END AS "reconciliationNeverCompleted"
    `.execute(this.database)
    ).rows[0];
    if (row === undefined) throw new Error('M7 aggregate measurement unavailable.');
    const value = (key: keyof ModerationOperationalHealth): number => {
      const number = Number(row[key]);
      if (!Number.isFinite(number) || number < 0)
        throw new Error('M7 aggregate measurement invalid.');
      return number;
    };
    return {
      oldestPendingReportAgeSeconds: value('oldestPendingReportAgeSeconds'),
      oldestInReviewAgeSeconds: value('oldestInReviewAgeSeconds'),
      activeReconciliationAgeSeconds: value('activeReconciliationAgeSeconds'),
      completedReconciliationAgeSeconds: value('completedReconciliationAgeSeconds'),
      reconciliationNeverCompleted: value('reconciliationNeverCompleted'),
    };
  }
}
