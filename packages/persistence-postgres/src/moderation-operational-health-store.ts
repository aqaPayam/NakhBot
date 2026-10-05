import { sql, type RawBuilder } from 'kysely';
import {
  M7_OPERATIONAL_HEALTH_NUMERIC_FIELDS,
  PrepareM7OperationalHealthHandler,
  GetM7OperationalHealthHandler,
  AdminActionAuthorizationService,
  type OpaqueTokenStore,
  type M7OperationalHealthStore,
} from '@nakh/application';
import type { M7OperationalHealth } from '@nakh/contracts';
import type { NakhDatabase } from './database.js';
import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';
import { withModerationIntegrityRead } from './moderation-integrity-metrics-store.js';
import { PostgresAdminAuthorizationStore } from './admin-authorization-store.js';
import { PostgresAdminQueueIdentityStore } from './queue-actions-store.js';

type HealthRow = Record<Exclude<keyof M7OperationalHealth, 'sampledAt'>, string> & {
  sampledAt: Date;
};
/** Narrow contract fields use their owning flags, never whole support/appeal phase totals.
 * Snapshot failure means capture metadata shape; cryptographic authentication belongs to audited readers. */
export function moderationOperationalHealthStatement(): RawBuilder<HealthRow> {
  return sql<HealthRow>`SELECT statement_timestamp() AS "sampledAt",
    COALESCE(floor(greatest(0,extract(epoch FROM statement_timestamp() - (
      SELECT submitted_at FROM moderation.reports WHERE status IN ('submitted','pending_review') ORDER BY submitted_at,id LIMIT 1)))),0)::text AS "oldestPendingReportAgeSeconds",
    COALESCE(floor(greatest(0,extract(epoch FROM statement_timestamp() - (
      SELECT updated_at FROM moderation.moderation_reviews WHERE status = 'in_review' ORDER BY updated_at,id LIMIT 1)))),0)::text AS "oldestInReviewAgeSeconds",
    (SELECT count(*)::text FROM (${MODERATION_INTEGRITY_SOURCES.episodes}) probe
      WHERE probe."sourceMatches" IS NOT TRUE OR probe."hasOneSystemAction" IS NOT TRUE) AS "thresholdMismatchCount",
    (SELECT count(*)::text FROM (${MODERATION_INTEGRITY_SOURCES.admin_logs}) probe
      WHERE probe."hasAccess" IS NOT TRUE OR probe."hasAction" IS NOT TRUE) AS "adminLogMismatchCount",
    (SELECT count(*)::text FROM (${MODERATION_INTEGRITY_SOURCES.evidence}) probe
      WHERE probe."hasCapture" IS NOT TRUE) AS "snapshotIntegrityFailureCount",
    (SELECT count(*)::text FROM (${MODERATION_INTEGRITY_SOURCES.support_threads}) probe
      WHERE probe."withinLimit" IS NOT TRUE) AS "supportLimitMismatchCount",
    (SELECT count(*)::text FROM (${MODERATION_INTEGRITY_SOURCES.appeals}) probe
      WHERE probe."uniqueBan" IS NOT TRUE) AS "appealUniquenessMismatchCount"`;
}
export class PostgresM7OperationalHealthStore implements M7OperationalHealthStore {
  public constructor(private readonly database: NakhDatabase) {}
  public async measure(): Promise<M7OperationalHealth> {
    const rows = await withModerationIntegrityRead(
      this.database,
      async (tx) => (await moderationOperationalHealthStatement().execute(tx)).rows,
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      !(row.sampledAt instanceof Date) ||
      !Number.isFinite(row.sampledAt.getTime())
    )
      throw new Error('M7 operational health unavailable.');
    const values = Object.fromEntries(
      M7_OPERATIONAL_HEALTH_NUMERIC_FIELDS.map((key) => {
        const value = Number(row[key]);
        if (!Number.isSafeInteger(value) || value < 0)
          throw new Error('M7 operational health invalid.');
        return [key, value];
      }),
    );
    return { sampledAt: row.sampledAt.toISOString(), ...values } as M7OperationalHealth;
  }
}
export function createPostgresM7OperationalHealthHandlers(
  database: NakhDatabase,
  tokens: OpaqueTokenStore,
  key: Uint8Array,
): Readonly<{
  prepare: PrepareM7OperationalHealthHandler;
  get: GetM7OperationalHealthHandler;
}> {
  const facts = new PostgresAdminAuthorizationStore(database);
  const authorization = new AdminActionAuthorizationService(facts, tokens, key);
  return {
    prepare: new PrepareM7OperationalHealthHandler(
      new PostgresAdminQueueIdentityStore(database),
      facts,
      authorization,
    ),
    get: new GetM7OperationalHealthHandler(
      facts,
      authorization,
      new PostgresM7OperationalHealthStore(database),
    ),
  };
}
