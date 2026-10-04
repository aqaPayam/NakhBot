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
    SELECT thread.id, thread.status <> 'open' OR (SELECT count(*) FROM (
      SELECT message.id FROM support.support_messages message
      JOIN support.support_threads owned ON owned.id = message.support_thread_id
      WHERE owned.user_id = thread.user_id AND owned.status = 'open' AND message.sender_type = 'user'
        AND NOT EXISTS (SELECT 1 FROM support.support_messages reply
          JOIN support.support_threads replied ON replied.id = reply.support_thread_id
          WHERE replied.user_id = thread.user_id AND reply.sender_type = 'admin'
            AND (reply.created_at, reply.id) >= (message.created_at, message.id))
      LIMIT 3
    ) unanswered) <= 2 AS "withinLimit",
    NOT EXISTS (SELECT 1 FROM support.support_messages message WHERE message.support_thread_id = thread.id
      AND message.sender_type = 'admin' AND NOT EXISTS (
        SELECT 1 FROM administration.admin_action_logs attempt WHERE attempt.admin_user_id = message.sender_admin_id
          AND attempt.command_id = message.command_id AND attempt.request_id = message.request_id
          AND attempt.request_digest = message.request_digest AND attempt.command_code = 'support.reply-thread'
          AND attempt.target_type = 'support_thread' AND attempt.target_id = thread.id AND attempt.result = 'succeeded'
          AND attempt.expected_target_version = message.thread_version_after - 1
      )) AND (thread.status <> 'closed' OR EXISTS (
        SELECT 1 FROM administration.admin_action_logs attempt WHERE attempt.command_code = 'support.close-thread'
          AND attempt.target_type = 'support_thread' AND attempt.target_id = thread.id AND attempt.result = 'succeeded'
          AND attempt.expected_target_version = thread.version - 1
      )) AS "hasAttempts"
    FROM support.support_threads thread
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR thread.id > ${cursor.lastId ?? null}::uuid
    ORDER BY thread.id LIMIT ${limit}
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
    await sql<{ id: string; banMatches: boolean; hasReview: boolean; unbanMatches: boolean }>`
    SELECT appeal.id, EXISTS (SELECT 1 FROM identity.account_state_history ban WHERE ban.id = appeal.ban_state_history_id
      AND ban.user_id = appeal.user_id AND ban.next_state = 'banned') AS "banMatches",
    appeal.status NOT IN ('accepted','rejected') OR EXISTS (
      SELECT 1 FROM administration.admin_action_logs attempt JOIN platform.audit_logs audit
        ON audit.command_id = attempt.command_id AND audit.actor_admin_id = attempt.admin_user_id
      WHERE attempt.admin_user_id = appeal.reviewed_by_admin_id AND attempt.target_type = 'user_appeal'
        AND attempt.target_id = appeal.id AND attempt.command_code = 'moderation.review-appeal' AND attempt.result = 'succeeded'
        AND attempt.expected_target_version = appeal.version - 1 AND audit.subject_type = 'user_appeal'
        AND audit.subject_id = appeal.id AND audit.event_type = 'moderation.appeal-reviewed.v1'
        AND audit.result_code = 'appeal_' || appeal.status AND audit.request_id = attempt.request_id
    ) AS "hasReview",
    NOT EXISTS (SELECT 1 FROM moderation.appeal_unbans unban WHERE unban.appeal_id = appeal.id AND NOT EXISTS (
      SELECT 1 FROM moderation.moderation_actions action
      JOIN identity.account_state_history history ON history.id = unban.unban_history_id
      JOIN administration.admin_action_logs attempt ON attempt.id = unban.admin_action_log_id
      WHERE action.id = unban.action_id AND appeal.status = 'accepted' AND action.action_type = 'unban_user'
        AND action.target_user_id = appeal.user_id AND history.user_id = appeal.user_id AND history.previous_state = 'banned'
        AND history.actor_admin_id = action.actor_admin_id AND history.changed_at = action.occurred_at
        AND attempt.admin_user_id = action.actor_admin_id AND attempt.command_id = action.command_id
        AND attempt.command_code = 'moderation.unban-appeal' AND attempt.target_type = 'user_appeal'
        AND attempt.target_id = appeal.id AND attempt.result = 'succeeded'
    )) AS "unbanMatches"
    FROM moderation.user_appeals appeal
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR appeal.id > ${cursor.lastId ?? null}::uuid
    ORDER BY appeal.id LIMIT ${limit}
  `.execute(database)
  ).rows;
  const findings: Finding[] = [];
  for (const row of rows)
    for (const anomalyType of [
      ...(!row.banMatches ? ['appeal_ban_event_mismatch'] : []),
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
    SELECT admin.id, NOT admin.is_active OR (admin.identity_verified_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM identity.telegram_identities identity WHERE identity.user_id = admin.user_id
        AND identity.telegram_user_id = admin.telegram_user_id)) AS "identityMatches"
    FROM administration.admin_users admin
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR admin.id > ${cursor.lastId ?? null}::uuid
    ORDER BY admin.id LIMIT ${limit}
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
    SELECT attempt.id, CASE
      WHEN attempt.command_code = 'moderation.reveal-evidence' AND attempt.target_type = 'report_evidence'
        AND EXISTS (SELECT 1 FROM moderation.report_evidence evidence WHERE evidence.id = attempt.target_id) THEN EXISTS (
          SELECT 1 FROM moderation.evidence_access_audits access WHERE access.admin_user_id = attempt.admin_user_id
            AND access.command_id = attempt.command_id AND access.request_id = attempt.request_id
            AND access.report_evidence_id = attempt.target_id AND access.safe_code = attempt.safe_code
            AND access.outcome = CASE attempt.result WHEN 'succeeded' THEN 'revealed' ELSE 'rejected' END)
      WHEN (attempt.command_code = 'support.reveal-thread' AND attempt.target_type = 'support_thread'
        AND EXISTS (SELECT 1 FROM support.support_threads thread WHERE thread.id = attempt.target_id))
        OR (attempt.command_code = 'moderation.reveal-appeal' AND attempt.target_type = 'user_appeal'
        AND EXISTS (SELECT 1 FROM moderation.user_appeals appeal WHERE appeal.id = attempt.target_id)) THEN EXISTS (
          SELECT 1 FROM administration.safety_access_audits access WHERE access.admin_action_log_id = attempt.id
            AND access.admin_user_id = attempt.admin_user_id AND access.command_id = attempt.command_id
            AND access.request_id = attempt.request_id AND access.safe_code = attempt.safe_code
            AND COALESCE(access.support_thread_id, access.user_appeal_id) = attempt.target_id
            AND access.outcome = CASE attempt.result WHEN 'succeeded' THEN 'revealed' ELSE 'rejected' END)
      ELSE true END AS "hasAccess",
      attempt.result <> 'succeeded' OR attempt.command_code NOT IN (
        'moderation.apply-account-action','moderation.apply-photo-action','moderation.change-internal-block','moderation.unban-appeal')
        OR EXISTS (SELECT 1 FROM moderation.moderation_actions action WHERE action.actor_admin_id = attempt.admin_user_id
          AND action.command_id = attempt.command_id AND action.request_id = attempt.request_id
          AND action.request_digest = attempt.request_digest) AS "hasAction"
    FROM administration.admin_action_logs attempt
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR attempt.id > ${cursor.lastId ?? null}::uuid
    ORDER BY attempt.id LIMIT ${limit}
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
    SELECT pair.user_low_id AS "lowId", pair.user_high_id AS "highId",
      NOT EXISTS (SELECT 1 FROM matching.matches match WHERE match.user_low_id = pair.user_low_id
        AND match.user_high_id = pair.user_high_id AND (match.status = 'active' OR EXISTS (
          SELECT 1 FROM chat.chat_sessions session WHERE session.match_id = match.id AND session.status = 'active')))
      AND NOT EXISTS (SELECT 1 FROM interaction.likes like_row WHERE like_row.status = 'active' AND (
        (like_row.sender_user_id = pair.user_low_id AND like_row.receiver_user_id = pair.user_high_id)
        OR (like_row.sender_user_id = pair.user_high_id AND like_row.receiver_user_id = pair.user_low_id)))
      AND NOT EXISTS (SELECT 1 FROM interaction.feature_unlocks unlock WHERE unlock.status = 'active' AND (
        EXISTS (SELECT 1 FROM matching.matches match WHERE match.id = unlock.match_id
          AND match.user_low_id = pair.user_low_id AND match.user_high_id = pair.user_high_id)
        OR EXISTS (SELECT 1 FROM interaction.likes like_row WHERE like_row.id = unlock.like_id AND (
          (like_row.sender_user_id = pair.user_low_id AND like_row.receiver_user_id = pair.user_high_id)
          OR (like_row.sender_user_id = pair.user_high_id AND like_row.receiver_user_id = pair.user_low_id))))) AS closed
    FROM interaction.user_pair_states pair WHERE pair.state = 'blocked' AND (
      ${cursor.lastId ?? null}::uuid IS NULL OR (pair.user_low_id, pair.user_high_id) >
        (${cursor.lastId ?? null}::uuid, ${cursor.lastPairHighId ?? null}::uuid))
    ORDER BY pair.user_low_id, pair.user_high_id LIMIT ${limit}
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
