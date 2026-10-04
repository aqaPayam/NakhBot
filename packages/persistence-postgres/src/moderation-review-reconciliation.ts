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
    SELECT review.id, EXISTS (SELECT 1 FROM moderation.reports report WHERE report.id = review.report_id AND (
      (review.status IN ('pending','in_review') AND report.status = 'pending_review')
      OR (review.status IN ('dismissed','actioned') AND report.status = review.status)
    )) AS "stateMatches",
    review.status NOT IN ('dismissed','actioned') OR EXISTS (
      SELECT 1 FROM moderation.moderation_actions action WHERE action.source_report_id = review.report_id
        AND action.actor_type = 'admin'
        AND ((review.status = 'dismissed' AND action.action_type = 'dismiss_report')
          OR (review.status = 'actioned' AND action.action_type <> 'dismiss_report'))
    ) AS "hasDecisionEvidence"
    FROM moderation.moderation_reviews review
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR review.id > ${cursor.lastId ?? null}::uuid
    ORDER BY review.id LIMIT ${limit}
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
    SELECT action.id, EXISTS (SELECT 1 FROM platform.audit_logs audit WHERE audit.id = action.audit_log_id
      AND audit.actor_type = action.actor_type AND audit.actor_admin_id IS NOT DISTINCT FROM action.actor_admin_id
      AND audit.command_id = action.command_id AND audit.request_id = action.request_id) AS "hasAudit",
    action.actor_type = 'system' OR EXISTS (
      SELECT 1 FROM administration.admin_action_logs attempt
      WHERE attempt.admin_user_id = action.actor_admin_id AND attempt.command_id = action.command_id
        AND attempt.request_id = action.request_id AND attempt.request_digest = action.request_digest AND attempt.result = 'succeeded'
        AND ((action.action_type = 'unban_user' AND EXISTS (SELECT 1 FROM moderation.appeal_unbans unban
          WHERE unban.action_id = action.id AND unban.admin_action_log_id = attempt.id
            AND attempt.command_code = 'moderation.unban-appeal' AND attempt.target_type = 'user_appeal'
            AND attempt.target_id = unban.appeal_id))
          OR (action.action_type IN ('restrict_user','unrestrict_user','ban_user','unban_user')
            AND attempt.command_code = 'moderation.apply-account-action' AND attempt.target_type = 'user'
            AND attempt.target_id = action.target_user_id)
          OR (action.action_type IN ('hide_photo','restore_photo','delete_photo')
            AND attempt.command_code = 'moderation.apply-photo-action' AND attempt.target_type = 'photo'
            AND attempt.target_id = action.target_photo_id)
          OR (action.action_type = 'dismiss_report' AND attempt.command_code = 'moderation.decide-review'
            AND attempt.target_type = 'moderation_review' AND EXISTS (SELECT 1 FROM moderation.moderation_reviews review
              WHERE review.id = attempt.target_id AND review.report_id = action.source_report_id))
          OR (action.action_type IN ('create_internal_block','remove_internal_block')
            AND attempt.command_code = 'moderation.change-internal-block' AND attempt.target_type = 'user_pair'
            AND EXISTS (SELECT 1 FROM platform.audit_logs audit WHERE audit.id = action.audit_log_id
              AND audit.subject_type = 'user_pair' AND audit.subject_id = attempt.target_id)))
    ) AS "hasAttempt",
    action.action_type NOT IN ('restrict_user','unrestrict_user','ban_user','unban_user') OR EXISTS (
      SELECT 1 FROM identity.account_state_history history WHERE history.user_id = action.target_user_id
        AND history.actor_type = action.actor_type AND history.actor_admin_id IS NOT DISTINCT FROM action.actor_admin_id
        AND history.reason_code = action.reason_code AND history.changed_at = action.occurred_at
        AND ((action.action_type = 'restrict_user' AND history.next_state = 'restricted')
          OR (action.action_type = 'ban_user' AND history.next_state = 'banned')
          OR (action.action_type IN ('unrestrict_user','unban_user')
            AND history.previous_state = CASE action.action_type WHEN 'unrestrict_user' THEN 'restricted' ELSE 'banned' END
            AND history.next_state = (SELECT prior.previous_state FROM identity.account_state_history prior
              WHERE prior.user_id = action.target_user_id AND prior.next_state = history.previous_state
                AND prior.changed_at <= action.occurred_at
                AND (action.action_type <> 'unrestrict_user' OR prior.previous_state <> 'banned')
              ORDER BY prior.changed_at DESC, prior.id DESC LIMIT 1)))
    ) AS "hasAccountHistory",
    action.action_type NOT IN ('restrict_user','unrestrict_user','ban_user','unban_user') OR EXISTS (
      SELECT 1 FROM notification.notifications notice WHERE notice.id = action.notification_id
        AND notice.user_id = action.target_user_id AND notice.payload = '{}'::jsonb
        AND notice.notification_type = CASE action.action_type WHEN 'restrict_user' THEN 'restriction_warning'
          WHEN 'ban_user' THEN 'ban_warning' ELSE 'admin_notice' END
    ) AS "hasNotice",
    action.source_report_id IS NULL OR EXISTS (
      SELECT 1 FROM moderation.reports report WHERE report.id = action.source_report_id
        AND (report.target_user_id = action.target_user_id OR EXISTS (
          SELECT 1 FROM media.profile_photos photo JOIN profile.profiles profile ON profile.id = photo.profile_id
          WHERE photo.id = action.target_photo_id AND profile.user_id = report.target_user_id))
    ) AS "reportMatches"
    FROM moderation.moderation_actions action
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR action.id > ${cursor.lastId ?? null}::uuid
    ORDER BY action.id LIMIT ${limit}
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
    SELECT episode.id, EXISTS (SELECT 1 FROM moderation.reports report WHERE report.id = episode.source_report_id
      AND report.target_user_id = episode.target_user_id) AS "sourceMatches",
    (SELECT count(*) FROM moderation.moderation_actions action WHERE action.restriction_episode_id = episode.id
      AND action.actor_type = 'system' AND action.action_type = 'restrict_user'
      AND action.target_user_id = episode.target_user_id AND action.source_report_id = episode.source_report_id) = 1 AS "hasOneSystemAction"
    FROM moderation.restriction_episodes episode
    WHERE ${cursor.lastId ?? null}::uuid IS NULL OR episode.id > ${cursor.lastId ?? null}::uuid
    ORDER BY episode.id LIMIT ${limit}
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
