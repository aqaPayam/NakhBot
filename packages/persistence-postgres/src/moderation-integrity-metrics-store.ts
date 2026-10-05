import { sql, type RawBuilder } from 'kysely';
import {
  MODERATION_RECONCILIATION_PHASES,
  type ModerationReconciliationPhase,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import {
  MODERATION_INTEGRITY_SOURCES,
  MODERATION_INTEGRITY_FLAGS,
} from './moderation-integrity-sources.js';

export type ModerationIntegritySample = Readonly<{
  sampledAt: Date;
  counts: Readonly<Record<ModerationReconciliationPhase, number>>;
}>;
type IntegrityRow = { phase: ModerationReconciliationPhase; sampledAt: Date; count: string };
export function moderationIntegrityPhaseStatement(
  phase: ModerationReconciliationPhase,
): RawBuilder<IntegrityRow> {
  return sql<{ phase: ModerationReconciliationPhase; sampledAt: Date; count: string }>`
      SELECT ${phase}::text AS phase, statement_timestamp() AS "sampledAt", count(*)::text AS count
      FROM (${MODERATION_INTEGRITY_SOURCES[phase]}) probe
      WHERE ${sql.join(
        MODERATION_INTEGRITY_FLAGS[phase].map(
          (flag) => sql`${sql.ref(`probe.${flag}`)} IS NOT TRUE`,
        ),
        sql` OR `,
      )}
    `;
}
export function moderationIntegrityStatement(): RawBuilder<IntegrityRow> {
  return sql<{ phase: ModerationReconciliationPhase; sampledAt: Date; count: string }>`
    ${sql.join(MODERATION_RECONCILIATION_PHASES.map(moderationIntegrityPhaseStatement), sql` UNION ALL `)}
  `;
}

/** One database snapshot, current violating entities per phase, never historical quarantines.
 * Aggregation stays in PostgreSQL. No entity identity or restricted content enters the host. */
export class PostgresModerationIntegrityMetricsStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async measure(): Promise<ModerationIntegritySample> {
    const rows = (await moderationIntegrityStatement().execute(this.database)).rows;
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
