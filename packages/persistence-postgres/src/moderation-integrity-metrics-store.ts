import { sql, type RawBuilder } from 'kysely';
import {
  MODERATION_RECONCILIATION_PHASES,
  type ModerationReconciliationPhase,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import {
  MODERATION_INTEGRITY_SOURCES,
  moderationAppealMetadataSource,
  MODERATION_INTEGRITY_FLAGS,
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
 * Dense metadata joins can benefit from parallel reads without reducing minimum
 * relation sizes. Shared parallel hashes can exhaust a container's dynamic shared
 * memory across the combined phases. Use private hash tables within the same
 * per-node work budget. Cap each gather at one worker plus its leader, respecting
 * lower operator limits (including disabled parallelism). The combined ten-phase
 * snapshot uses zero workers: repeated worker launches cost more than its short
 * membership scans save. Individual phase and health reads retain the one-worker cap.
 * LOCAL settings expire at commit/rollback,
 * including failed reads, and never change the pooled session or database configuration. */
export async function withModerationIntegrityRead<T>(
  database: NakhDatabase,
  work: (transaction: NakhDatabase) => Promise<T>,
  maximumParallelWorkers: 0 | 1 = 1,
): Promise<T> {
  if (maximumParallelWorkers !== 0 && maximumParallelWorkers !== 1)
    throw new Error('M7 integrity read limit is invalid.');
  const read = async (transaction: NakhDatabase): Promise<T> => {
    await sql`SET LOCAL jit = off`.execute(transaction);
    await sql`SET LOCAL work_mem = '16MB'`.execute(transaction);
    await sql`SET LOCAL enable_parallel_hash = off`.execute(transaction);
    await sql`SET LOCAL parallel_setup_cost = 250`.execute(transaction);
    await sql`SET LOCAL parallel_tuple_cost = 0.01`.execute(transaction);
    await sql`SELECT set_config('max_parallel_workers_per_gather',
      LEAST(current_setting('max_parallel_workers_per_gather')::integer,${maximumParallelWorkers})::text,true)`.execute(
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
  if (phase === 'actions') {
    // CASE guarantees that already-invalid attempts do not perform expensive
    // history/notice membership probes. Complete scanner flags remain unchanged;
    // every entity still contributes exactly one count for any invalid flag.
    const priority = ['hasAttempt', 'hasAudit', 'hasNotice', 'reportMatches', 'hasAccountHistory'];
    const order = [...priority, ...flags.filter((flag) => !priority.includes(flag))];
    return sql<IntegrityRow>`SELECT ${phase}::text AS phase,
      statement_timestamp() AS "sampledAt", count(*)::text AS count
      FROM (${MODERATION_INTEGRITY_SOURCES.actions}) probe
      WHERE CASE ${sql.join(
        order.map((flag) => sql`WHEN ${sql.ref(`probe.${flag}`)} IS NOT TRUE THEN true`),
        sql` `,
      )}
        ELSE false END`;
  }
  if (phase === 'episodes') {
    const remaining = flags.filter((flag) => flag !== 'hasResolutionAttempt');
    return sql<IntegrityRow>`
      WITH episode_resolution_status AS MATERIALIZED (
        -- Resolved owner bounds batch the real covering-index read instead of
        -- opening one index probe per episode. Exact owner/actor/reason/time and
        -- attempt tuples remain independent membership proofs; duplicates cannot
        -- multiply an owner or combine fields across different resolutions.
        -- CASE leaves open episodes outside resolution validation.
        SELECT owner.id, owner.target_user_id, owner.source_report_id,
          owner.witness_required, owner.distinct_reporter_count, owner.started_at,
          CASE WHEN owner.status = 'resolved' THEN COALESCE((owner.id,owner.target_user_id,owner.resolved_by_admin_id,
          owner.resolution_reason_code,owner.resolved_at) IN (
          SELECT resolution.restriction_episode_id,resolution.target_user_id,resolution.actor_admin_id,
            resolution.reason_code,resolution.occurred_at
          FROM (
            SELECT min(id::text COLLATE "C")::uuid AS first_id,max(id::text COLLATE "C")::uuid AS last_id
            FROM moderation.restriction_episodes WHERE status='resolved'
          ) bounds CROSS JOIN LATERAL (
            SELECT restriction_episode_id,target_user_id,actor_admin_id,reason_code,occurred_at,
              command_id,request_id,request_digest
            FROM moderation.moderation_actions
            WHERE restriction_episode_id IS NOT NULL AND actor_type='admin' AND action_type='unrestrict_user'
              AND restriction_episode_id>=bounds.first_id AND restriction_episode_id<=bounds.last_id OFFSET 0
          ) resolution WHERE COALESCE((resolution.actor_admin_id,resolution.command_id,resolution.request_id,
          resolution.request_digest,resolution.target_user_id) IN (
          SELECT attempt.admin_user_id,attempt.command_id,attempt.request_id,attempt.request_digest,attempt.target_id
          FROM administration.admin_action_logs attempt WHERE attempt.result='succeeded'
            AND attempt.command_code='moderation.apply-account-action' AND attempt.target_type='user'
        ),false)
        ),false)
            ELSE true END AS resolution_valid
        FROM moderation.restriction_episodes owner
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
      FROM (${phase === 'appeals' ? moderationAppealMetadataSource(true) : MODERATION_INTEGRITY_SOURCES[phase]}) probe
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
      0,
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
