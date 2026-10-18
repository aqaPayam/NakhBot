import { sql, type RawBuilder } from 'kysely';
import type { NakhDatabase } from './database.js';
import type { LaunchAudience } from './launch-cohort-store.js';
import { PostgresModerationIntegrityMetricsStore } from './moderation-integrity-metrics-store.js';
import { PostgresModerationOperationalMetricsStore } from './moderation-operational-metrics-store.js';
import { PostgresAccountDeletionHealthStore } from './account-deletion-health-store.js';

export const LAUNCH_RECONCILIATION_TYPES = ['billing', 'nakh', 'chat', 'moderation'] as const;
type RunRow = {
  kind: (typeof LAUNCH_RECONCILIATION_TYPES)[number];
  status: 'started' | 'succeeded' | 'failed' | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  historicalFindings: string | null;
};
/** Four bounded latest-run probes using the existing time index. Findings are
 * historical scan results, never represented as current unresolved corruption. */
export function launchReconciliationHealthStatement(): RawBuilder<RunRow> {
  return sql<RunRow>`SELECT kinds.kind,latest.status,latest.started_at AS "startedAt",
    latest.finished_at AS "finishedAt",latest.anomaly_count::text AS "historicalFindings"
    FROM (VALUES ${sql.join(LAUNCH_RECONCILIATION_TYPES.map((kind) => sql`(${kind}::text)`))}) kinds(kind)
    LEFT JOIN LATERAL (SELECT status,started_at,finished_at,anomaly_count
      FROM billing.reconciliation_runs WHERE run_type=kinds.kind
      ORDER BY started_at DESC,id DESC LIMIT 1) latest ON true ORDER BY kinds.kind`;
}
export async function measureLaunchHealth(
  database: NakhDatabase,
  audience: LaunchAudience,
): Promise<{
  schemaVersion: 1;
  audience: LaunchAudience;
  observationScope: 'native_metadata';
  launchAuthorized: false;
  sampledAt: string;
  integrity: {
    sampledAt: string;
    counts: Awaited<ReturnType<PostgresModerationIntegrityMetricsStore['measure']>>['counts'];
  };
  safety: Awaited<ReturnType<PostgresModerationOperationalMetricsStore['measure']>>;
  deletion: {
    sampledAt: string;
    phases: Awaited<ReturnType<PostgresAccountDeletionHealthStore['measure']>>['phases'];
  };
  reconciliation: readonly {
    kind: RunRow['kind'];
    status: RunRow['status'];
    startedAt: string | null;
    finishedAt: string | null;
    historicalFindings: number | null;
  }[];
}> {
  // One read-only repeatable snapshot; native samplers retain their bounded LOCAL
  // execution settings. No reconciliation jobs, repairs, audits or provider calls.
  return database
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (tx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      const time = (
        await sql<{ sampledAt: Date }>`SELECT transaction_timestamp() AS "sampledAt"`.execute(tx)
      ).rows[0]!.sampledAt;
      const integrity = await new PostgresModerationIntegrityMetricsStore(tx).measure();
      const safety = await new PostgresModerationOperationalMetricsStore(tx).measure();
      const deletion = await new PostgresAccountDeletionHealthStore(tx).measure();
      const rows = (await launchReconciliationHealthStatement().execute(tx)).rows;
      if (
        rows.length !== LAUNCH_RECONCILIATION_TYPES.length ||
        new Set(rows.map((row) => row.kind)).size !== LAUNCH_RECONCILIATION_TYPES.length
      )
        throw new Error('Launch health unavailable.');
      const reconciliation = rows.map((row) => {
        const count = row.historicalFindings === null ? null : Number(row.historicalFindings);
        if (
          !LAUNCH_RECONCILIATION_TYPES.includes(row.kind) ||
          (row.status !== null && !['started', 'succeeded', 'failed'].includes(row.status)) ||
          (count !== null && (!Number.isSafeInteger(count) || count < 0)) ||
          (row.status === null
            ? row.startedAt !== null || row.finishedAt !== null || count !== null
            : !(row.startedAt instanceof Date) ||
              !Number.isFinite(row.startedAt.getTime()) ||
              count === null ||
              (row.status === 'started'
                ? row.finishedAt !== null
                : !(row.finishedAt instanceof Date) || !Number.isFinite(row.finishedAt.getTime())))
        )
          throw new Error('Launch health unavailable.');
        return {
          kind: row.kind,
          status: row.status,
          startedAt: row.startedAt?.toISOString() ?? null,
          finishedAt: row.finishedAt?.toISOString() ?? null,
          historicalFindings: count,
        };
      });
      return {
        schemaVersion: 1 as const,
        audience: { ...audience },
        observationScope: 'native_metadata' as const,
        launchAuthorized: false as const,
        sampledAt: time.toISOString(),
        integrity: { sampledAt: integrity.sampledAt.toISOString(), counts: integrity.counts },
        safety,
        deletion: { sampledAt: deletion.sampledAt.toISOString(), phases: deletion.phases },
        reconciliation,
      };
    });
}
