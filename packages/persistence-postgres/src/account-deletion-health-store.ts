import { sql, type RawBuilder } from 'kysely';
import { ACCOUNT_DELETION_PHASES, type AccountDeletionPhase } from '@nakh/domain';
import type {
  AccountDeletionHealthSample,
  AccountDeletionHealthStore,
  AccountDeletionPhaseHealth,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
type Row = {
  phase: AccountDeletionPhase;
  sampledAt: Date;
  records: string;
  leased: string;
  retrying: string;
  inconsistent: string;
  oldestAgeSeconds: number;
  dueAgeSeconds: number;
};
/** One MVCC statement and native clock; no private identifiers leave PostgreSQL.
 * Alignment is operational health, not a replacement for native completion proof. */
export function accountDeletionHealthStatement(): RawBuilder<Row> {
  return sql<Row>`WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at),
    facts AS (
      SELECT COALESCE(root.phase,work.phase) AS phase, COALESCE(root.requested_at,work.available_at) AS requested_at, COALESCE(work.available_at,root.requested_at) AS available_at,
        COALESCE(root.phase,work.phase)<>'completed' AS pending,
        (root.phase<>'completed' AND work.lease_owner IS NOT NULL AND work.lease_expires_at>observed.at) AS leased,
        (root.phase<>'completed' AND work.last_error_code IS NOT NULL) AS retrying,
        NOT COALESCE(CASE WHEN root.phase='completed' THEN
          root.completed_at IS NOT NULL AND root.checkpoint_version=8 AND work.phase='completed'
            AND work.checkpoint_version=8 AND work.lease_owner IS NULL AND work.lease_expires_at IS NULL
          ELSE root.completed_at IS NULL AND work.phase=root.phase
            AND work.checkpoint_version=root.checkpoint_version
            AND root.checkpoint_version=array_position(ARRAY[${sql.join(ACCOUNT_DELETION_PHASES.map((p) => sql`${p}::text`))}],root.phase)
            AND owner.state='deleted' AND owner.version=root.account_version AND owner.product_epoch=root.product_epoch
          END,false) AS inconsistent
      FROM identity.account_deletion_records root
      FULL JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
      LEFT JOIN identity.accounts owner ON owner.user_id=root.user_id CROSS JOIN observed
    ), totals AS (
      SELECT phase,count(*)::text AS records,count(*) FILTER(WHERE leased)::text AS leased,
        count(*) FILTER(WHERE retrying)::text AS retrying,count(*) FILTER(WHERE inconsistent)::text AS inconsistent,
        GREATEST(0,COALESCE(max(extract(epoch FROM (observed.at-requested_at))) FILTER(WHERE pending),0))::double precision AS "oldestAgeSeconds",
        GREATEST(0,COALESCE(max(extract(epoch FROM (observed.at-available_at))) FILTER(WHERE pending AND NOT leased),0))::double precision AS "dueAgeSeconds"
      FROM facts CROSS JOIN observed GROUP BY phase
    ) SELECT phases.phase,observed.at AS "sampledAt",COALESCE(totals.records,'0') AS records,
      COALESCE(totals.leased,'0') AS leased,COALESCE(totals.retrying,'0') AS retrying,
      COALESCE(totals.inconsistent,'0') AS inconsistent,COALESCE(totals."oldestAgeSeconds",0) AS "oldestAgeSeconds",
      COALESCE(totals."dueAgeSeconds",0) AS "dueAgeSeconds"
    FROM (VALUES ${sql.join(ACCOUNT_DELETION_PHASES.map((p) => sql`(${p}::text)`))}) phases(phase)
    CROSS JOIN observed LEFT JOIN totals USING(phase)`;
}
export class PostgresAccountDeletionHealthStore implements AccountDeletionHealthStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async measure(): Promise<AccountDeletionHealthSample> {
    const rows = (await accountDeletionHealthStatement().execute(this.database)).rows;
    const sampledAt = rows[0]?.sampledAt;
    if (
      rows.length !== ACCOUNT_DELETION_PHASES.length ||
      !(sampledAt instanceof Date) ||
      !Number.isFinite(sampledAt.getTime())
    )
      throw new Error('Deletion health unavailable.');
    const phases = {} as Record<AccountDeletionPhase, AccountDeletionPhaseHealth>;
    for (const row of rows) {
      const value = {
        records: Number(row.records),
        leased: Number(row.leased),
        retrying: Number(row.retrying),
        inconsistent: Number(row.inconsistent),
        oldestAgeSeconds: row.oldestAgeSeconds,
        dueAgeSeconds: row.dueAgeSeconds,
      };
      if (
        !ACCOUNT_DELETION_PHASES.includes(row.phase) ||
        Object.hasOwn(phases, row.phase) ||
        row.sampledAt.getTime() !== sampledAt.getTime() ||
        ![value.records, value.leased, value.retrying, value.inconsistent].every(
          (v) => Number.isSafeInteger(v) && v >= 0,
        ) ||
        ![value.oldestAgeSeconds, value.dueAgeSeconds].every(
          (v) => Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER,
        ) ||
        [value.leased, value.retrying, value.inconsistent].some((v) => v > value.records)
      )
        throw new Error('Deletion health unavailable.');
      phases[row.phase] = Object.freeze(value);
    }
    return Object.freeze({ sampledAt, phases: Object.freeze(phases) });
  }
}
