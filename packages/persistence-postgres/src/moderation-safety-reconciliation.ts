import { MODERATION_INTEGRITY_SOURCES } from './moderation-integrity-sources.js';
import { sql } from 'kysely';
import { canonicalAdminPairTargetId } from '@nakh/application';
import type { NakhDatabase } from './database.js';
import {
  nextPage,
  type Cursor,
  type Finding,
  type Scan,
} from './moderation-reconciliation-scan.js';
export async function scanSupportThreads(
  database: NakhDatabase,
  cursor: Cursor,
  limit: number,
): Promise<Scan> {
  const rows = (
    await sql<{ id: string; withinLimit: boolean; hasAttempts: boolean }>`
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.support_threads}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR probe.id > ${cursor.lastId ?? null}::uuid
    ORDER BY probe.id LIMIT ${limit}
  `.execute(database)
  ).rows;
  const findings: Finding[] = [];
  for (const row of rows)
    for (const anomalyType of [
      ...(!row.withinLimit ? ['support_unanswered_limit_mismatch'] : []),
      ...(!row.hasAttempts ? ['support_admin_attempt_missing'] : []),
    ])
      findings.push({
        anomalyType,
        entityType: 'support_thread',
        entityId: row.id,
        keyId: row.id,
        safeDetail: {},
      });
  return { findings, scannedCount: rows.length, nextCursor: nextPage(cursor, rows, limit) };
}
export async function scanAppeals(
  database: NakhDatabase,
  cursor: Cursor,
  limit: number,
): Promise<Scan> {
  const rows = (
    await sql<{
      id: string;
      banMatches: boolean;
      uniqueBan: boolean;
      hasReview: boolean;
      unbanMatches: boolean;
    }>`
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.appeals}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR probe.id > ${cursor.lastId ?? null}::uuid
    ORDER BY probe.id LIMIT ${limit}
  `.execute(database)
  ).rows;
  const findings: Finding[] = [];
  for (const row of rows)
    for (const anomalyType of [
      ...(!row.banMatches || !row.uniqueBan ? ['appeal_ban_event_mismatch'] : []),
      ...(!row.hasReview ? ['appeal_review_attempt_missing'] : []),
      ...(!row.unbanMatches ? ['appeal_unban_evidence_mismatch'] : []),
    ])
      findings.push({
        anomalyType,
        entityType: 'user_appeal',
        entityId: row.id,
        keyId: row.id,
        safeDetail: {},
      });
  return { findings, scannedCount: rows.length, nextCursor: nextPage(cursor, rows, limit) };
}
export async function scanAdmins(
  database: NakhDatabase,
  cursor: Cursor,
  limit: number,
): Promise<Scan> {
  const rows = (
    await sql<{ id: string; identityMatches: boolean }>`
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.admins}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR probe.id > ${cursor.lastId ?? null}::uuid
    ORDER BY probe.id LIMIT ${limit}
  `.execute(database)
  ).rows;
  return {
    scannedCount: rows.length,
    nextCursor: nextPage(cursor, rows, limit),
    findings: rows
      .filter((row) => !row.identityMatches)
      .map((row) => ({
        anomalyType: 'active_admin_identity_mismatch',
        entityType: 'admin_user' as const,
        entityId: row.id,
        keyId: row.id,
        safeDetail: {},
      })),
  };
}
export async function scanAdminLogs(
  database: NakhDatabase,
  cursor: Cursor,
  limit: number,
): Promise<Scan> {
  const rows = (
    await sql<{ id: string; hasAccess: boolean; hasAction: boolean }>`
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.admin_logs}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR probe.id > ${cursor.lastId ?? null}::uuid
    ORDER BY probe.id LIMIT ${limit}
  `.execute(database)
  ).rows;
  const findings: Finding[] = [];
  for (const row of rows)
    for (const anomalyType of [
      ...(!row.hasAccess ? ['admin_required_access_audit_missing'] : []),
      ...(!row.hasAction ? ['admin_successful_action_missing'] : []),
    ])
      findings.push({
        anomalyType,
        entityType: 'admin_action_log',
        entityId: row.id,
        keyId: row.id,
        safeDetail: {},
      });
  return { findings, scannedCount: rows.length, nextCursor: nextPage(cursor, rows, limit) };
}
export async function scanInternalBlocks(
  database: NakhDatabase,
  cursor: Cursor,
  limit: number,
): Promise<Scan> {
  const rows = (
    await sql<{ lowId: string; highId: string; closed: boolean }>`
SELECT * FROM (${MODERATION_INTEGRITY_SOURCES.internal_blocks}) probe
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR (probe."lowId", probe."highId") > (${cursor.lastId ?? null}::uuid, ${cursor.lastPairHighId ?? null}::uuid)
    ORDER BY probe."lowId", probe."highId" LIMIT ${limit}
  `.execute(database)
  ).rows;
  const last = rows.at(-1);
  return {
    scannedCount: rows.length,
    nextCursor:
      rows.length === limit && last !== undefined
        ? { phase: cursor.phase, lastId: last.lowId, lastPairHighId: last.highId }
        : nextPage(cursor, [], limit),
    findings: rows
      .filter((row) => !row.closed)
      .map((row) => {
        const id = canonicalAdminPairTargetId({ userLowId: row.lowId, userHighId: row.highId });
        return {
          anomalyType: 'internal_block_active_relationship',
          entityType: 'internal_block' as const,
          entityId: id,
          keyId: id,
          safeDetail: {},
        };
      }),
  };
}
