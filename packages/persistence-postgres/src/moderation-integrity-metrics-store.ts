import { sql, type RawBuilder } from 'kysely';
import {
  MODERATION_RECONCILIATION_PHASES,
  type ModerationReconciliationPhase,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import {
  MODERATION_INTEGRITY_SOURCES,
  MODERATION_INTEGRITY_FLAGS,
  MODERATION_EPISODE_RESOLUTION_FACTS,
  moderationEpisodeMetadataSource,
} from './moderation-integrity-sources.js';

export type ModerationIntegritySample = Readonly<{
  sampledAt: Date;
  counts: Readonly<Record<ModerationReconciliationPhase, number>>;
}>;
type IntegrityRow = { phase: ModerationReconciliationPhase; sampledAt: Date; count: string };
/** Periodic metadata reads are short, not analytical workloads. Avoid compiling the many
 * correlated safety branches on every sample. A fixed 16 MiB per-node work budget avoids
 * spilling ordinary metadata joins; it is not a total connection/process memory bound.
 * Dense metadata joins can benefit from parallel workers without reducing the
 * minimum relation sizes. Keep setup cost nonzero and cap each gather at two
 * workers, respecting a lower operator limit (including disabled parallelism).
 * LOCAL settings expire at commit/rollback,
 * including failed reads, and never change the pooled session or database configuration. */
export async function withModerationIntegrityRead<T>(
  database: NakhDatabase,
  work: (transaction: NakhDatabase) => Promise<T>,
): Promise<T> {
  const read = async (transaction: NakhDatabase): Promise<T> => {
    await sql`SET LOCAL jit = off`.execute(transaction);
    await sql`SET LOCAL work_mem = '16MB'`.execute(transaction);
    await sql`SET LOCAL parallel_setup_cost = 100`.execute(transaction);
    await sql`SET LOCAL parallel_tuple_cost = 0.03`.execute(transaction);
    await sql`SELECT set_config('max_parallel_workers_per_gather',
      LEAST(current_setting('max_parallel_workers_per_gather')::integer,2)::text,true)`.execute(
      transaction,
    );
    return work(transaction);
  };
  return database.isTransaction ? read(database) : database.transaction().execute(read);
}
export function moderationIntegrityPhaseStatement(
  phase: ModerationReconciliationPhase,
): RawBuilder<IntegrityRow> {
  // One count per entity: a failed resolution is already a proven violation.
  // Keep complete flags in the scanner; evaluate other aggregate flags only for
  // resolution-valid episodes within this same database statement/snapshot.
  const flags = MODERATION_INTEGRITY_FLAGS[phase];
  if (phase === 'episodes') {
    const remaining = flags.filter((flag) => flag !== 'hasResolutionAttempt');
    return sql<IntegrityRow>`
      ${MODERATION_EPISODE_RESOLUTION_FACTS}, episode_resolution_status AS MATERIALIZED (
        SELECT episode.*, (episode.status <> 'resolved' OR COALESCE(binding.valid,false)) AS resolution_valid
        FROM moderation.restriction_episodes episode
        LEFT JOIN resolution_facts binding ON binding.restriction_episode_id=episode.id
      ), eligible_episodes AS MATERIALIZED (
        SELECT * FROM episode_resolution_status WHERE resolution_valid
      )
      SELECT ${phase}::text AS phase, statement_timestamp() AS "sampledAt", (
        (SELECT count(*) FROM episode_resolution_status WHERE NOT resolution_valid)
        + (SELECT count(*) FROM (${moderationEpisodeMetadataSource(true)}) probe
          WHERE ${sql.join(
            remaining.map((flag) => sql`${sql.ref(`probe.${flag}`)} IS NOT TRUE`),
            sql` OR `,
          )})
      )::text AS count
    `;
  }
  return sql<{ phase: ModerationReconciliationPhase; sampledAt: Date; count: string }>`
      SELECT ${phase}::text AS phase, statement_timestamp() AS "sampledAt", count(*)::text AS count
      FROM (${MODERATION_INTEGRITY_SOURCES[phase]}) probe
      WHERE ${sql.join(
        flags.map((flag) => sql`${sql.ref(`probe.${flag}`)} IS NOT TRUE`),
        sql` OR `,
      )}
    `;
}
export function moderationIntegrityStatement(): RawBuilder<IntegrityRow> {
  return sql<{ phase: ModerationReconciliationPhase; sampledAt: Date; count: string }>`
    ${sql.join(
      MODERATION_RECONCILIATION_PHASES.map(
        (phase) => sql`(${moderationIntegrityPhaseStatement(phase)})`,
      ),
      sql` UNION ALL `,
    )}
  `;
}

/** One database snapshot, current violating entities per phase, never historical quarantines.
 * Aggregation stays in PostgreSQL. No entity identity or restricted content enters the host. */
export class PostgresModerationIntegrityMetricsStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async measure(): Promise<ModerationIntegritySample> {
    const rows = await withModerationIntegrityRead(
      this.database,
      async (transaction) => (await moderationIntegrityStatement().execute(transaction)).rows,
    );
    if (rows.length !== MODERATION_RECONCILIATION_PHASES.length)
      throw new Error('M7 integrity measurement unavailable.');
    const counts = {} as Record<ModerationReconciliationPhase, number>;
    const sampledAt = rows[0]!.sampledAt;
    for (const row of rows) {
      const value = Number(row.count);
      if (
        !MODERATION_RECONCILIATION_PHASES.includes(row.phase) ||
        Object.hasOwn(counts, row.phase) ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        !(row.sampledAt instanceof Date) ||
        !Number.isFinite(row.sampledAt.getTime()) ||
        row.sampledAt.getTime() !== sampledAt.getTime()
      )
        throw new Error('M7 integrity measurement invalid.');
      counts[row.phase] = value;
    }
    return { sampledAt, counts };
  }
}
