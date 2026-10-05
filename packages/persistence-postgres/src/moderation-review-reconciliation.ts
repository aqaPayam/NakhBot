import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';
import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';
import {
  nextPage,
  type Cursor,
  type Finding,
  type Scan,
} from './moderation-reconciliation-scan.js';
export async function scanModerationReviews(
  database: NakhDatabase,
  cursor: Cursor,
  limit: number,
): Promise<Scan> {
  const rows = (
    await sql<{ id: string; stateMatches: boolean; hasDecisionEvidence: boolean }>`
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.reviews}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR probe.id > ${cursor.lastId ?? null}::uuid
    ORDER BY probe.id LIMIT ${limit}
  `.execute(database)
  ).rows;
  const findings: Finding[] = [];
  for (const row of rows)
    for (const anomalyType of [
      ...(!row.stateMatches ? ['review_report_state_mismatch'] : []),
      ...(!row.hasDecisionEvidence ? ['review_decision_action_missing'] : []),
    ])
      findings.push({
        anomalyType,
        entityType: 'moderation_review',
        entityId: row.id,
        keyId: row.id,
        safeDetail: {},
      });
  return { findings, scannedCount: rows.length, nextCursor: nextPage(cursor, rows, limit) };
}
export async function scanModerationActions(
  database: NakhDatabase,
  cursor: Cursor,
  limit: number,
): Promise<Scan> {
  const rows = (
    await sql<{
      id: string;
      hasAudit: boolean;
      hasAttempt: boolean;
      hasAccountHistory: boolean;
      hasNotice: boolean;
      reportMatches: boolean;
    }>`
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.actions}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR probe.id > ${cursor.lastId ?? null}::uuid
    ORDER BY probe.id LIMIT ${limit}
  `.execute(database)
  ).rows;
  const findings: Finding[] = [];
  for (const row of rows)
    for (const anomalyType of [
      ...(!row.hasAudit ? ['moderation_action_audit_missing'] : []),
      ...(!row.hasAttempt ? ['moderation_action_attempt_missing'] : []),
      ...(!row.hasAccountHistory ? ['moderation_action_history_missing'] : []),
      ...(!row.hasNotice ? ['moderation_action_notice_invalid'] : []),
      ...(!row.reportMatches ? ['moderation_action_report_mismatch'] : []),
    ])
      findings.push({
        anomalyType,
        entityType: 'moderation_action',
        entityId: row.id,
        keyId: row.id,
        safeDetail: {},
      });
  return { findings, scannedCount: rows.length, nextCursor: nextPage(cursor, rows, limit) };
}
export async function scanRestrictionEpisodes(
  database: NakhDatabase,
  cursor: Cursor,
  limit: number,
): Promise<Scan> {
  const rows = (
    await sql<{ id: string; sourceMatches: boolean; hasOneSystemAction: boolean }>`
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.episodes}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR probe.id > ${cursor.lastId ?? null}::uuid
    ORDER BY probe.id LIMIT ${limit}
  `.execute(database)
  ).rows;
  const findings: Finding[] = [];
  for (const row of rows)
    for (const anomalyType of [
      ...(!row.sourceMatches ? ['threshold_episode_source_mismatch'] : []),
      ...(!row.hasOneSystemAction ? ['threshold_episode_action_missing'] : []),
    ])
      findings.push({
        anomalyType,
        entityType: 'restriction_episode',
        entityId: row.id,
        keyId: row.id,
        safeDetail: {},
      });
  return { findings, scannedCount: rows.length, nextCursor: nextPage(cursor, rows, limit) };
}
