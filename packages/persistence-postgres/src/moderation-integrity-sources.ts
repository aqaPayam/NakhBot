import { sql, type RawBuilder } from 'kysely';
import type { ModerationReconciliationPhase } from '@nakh/application';
/** Split null and exact administrator bindings so PostgreSQL can use the actor/history index. */
function accountHistoryMatches(adminMatches: RawBuilder<unknown>): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (
      SELECT 1 FROM identity.account_state_history history WHERE history.user_id = action.target_user_id
        AND history.actor_type = action.actor_type AND ${adminMatches}
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
    )`;
}

/** Owning metadata predicates shared by paged reconciliation and live aggregate sampling.
 * No prose, ciphertext, snapshot bodies, credentials or object keys leave these queries. */
export const MODERATION_INTEGRITY_SOURCES = {
  reports: sql`
SELECT report.id, EXISTS (SELECT 1 FROM moderation.report_evidence evidence
        WHERE evidence.report_id = report.id) AS "hasEvidence"
      FROM moderation.reports report
`,
  evidence: sql`
SELECT evidence.id, evidence.report_id AS "reportId", evidence.evidence_type AS "evidenceType",
        CASE WHEN evidence.evidence_type = 'message' THEN EXISTS (
          SELECT 1 FROM chat.chat_message_snapshots snapshot WHERE snapshot.report_id = evidence.report_id
            AND snapshot.original_message_id = evidence.chat_message_id
        ) ELSE EXISTS (
          SELECT 1 FROM moderation.report_snapshots snapshot WHERE snapshot.report_evidence_id = evidence.id
            AND snapshot.report_id = evidence.report_id AND snapshot.snapshot_type = evidence.evidence_type
            AND snapshot.schema_version = 1 AND snapshot.encryption_key_version >= 1
            AND octet_length(snapshot.nonce) = 12 AND octet_length(snapshot.ciphertext) BETWEEN 17 AND 65536
            AND snapshot.content_sha256 ~ '^[0-9a-f]{64}$'
        ) END AS "hasCapture",
        evidence.evidence_type <> 'photo' OR EXISTS (
          SELECT 1 FROM media.report_photo_evidence_holds hold
          JOIN media.photo_variants variant ON variant.id = hold.variant_id AND variant.asset_id = hold.asset_id
          JOIN media.media_assets asset ON asset.id = hold.asset_id
          WHERE hold.report_evidence_id = evidence.id AND hold.photo_id = evidence.profile_photo_id
            AND variant.variant_type = 'thumbnail' AND variant.transformation_version = 1
            AND encode(variant.sha256, 'hex') = hold.content_sha256
            AND variant.storage_deleted_at IS NULL AND asset.storage_deleted_at IS NULL
        ) AS "hasRetainedPhoto"
      FROM moderation.report_evidence evidence
`,
  reviews: sql`
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
`,
  actions: sql`
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
            AND attempt.target_id = moderation.admin_pair_target_id(action.target_pair_low_user_id, action.target_pair_high_user_id)
            AND EXISTS (SELECT 1 FROM platform.audit_logs audit WHERE audit.id = action.audit_log_id
              AND audit.subject_type = 'user_pair' AND audit.subject_id = attempt.target_id)))
    ) AS "hasAttempt",
    action.action_type NOT IN ('restrict_user','unrestrict_user','ban_user','unban_user') OR
      CASE WHEN action.actor_admin_id IS NULL
        THEN ${accountHistoryMatches(sql`history.actor_admin_id IS NULL`)}
        ELSE ${accountHistoryMatches(sql`history.actor_admin_id = action.actor_admin_id`)} END AS "hasAccountHistory",
    action.action_type NOT IN ('restrict_user','unrestrict_user','ban_user','unban_user') OR EXISTS (
      SELECT 1 FROM notification.notifications notice WHERE notice.id = action.notification_id
        AND notice.user_id = action.target_user_id AND notice.payload = '{}'::jsonb
        AND notice.notification_type = CASE action.action_type WHEN 'restrict_user' THEN 'restriction_warning'
          WHEN 'ban_user' THEN 'ban_warning' ELSE 'admin_notice' END
    ) AS "hasNotice",
    action.source_report_id IS NULL OR EXISTS (
      SELECT 1 FROM moderation.reports report WHERE report.id = action.source_report_id
        AND ((action.action_type IN ('create_internal_block','remove_internal_block')
            AND LEAST(report.reporter_user_id, report.target_user_id) = action.target_pair_low_user_id
            AND GREATEST(report.reporter_user_id, report.target_user_id) = action.target_pair_high_user_id)
          OR report.target_user_id = action.target_user_id OR EXISTS (
          SELECT 1 FROM media.profile_photos photo JOIN profile.profiles profile ON profile.id = photo.profile_id
          WHERE photo.id = action.target_photo_id AND profile.user_id = report.target_user_id))
    ) AS "reportMatches"
    FROM moderation.moderation_actions action
`,
  episodes: sql`
SELECT episode.id, EXISTS (SELECT 1 FROM moderation.reports report WHERE report.id = episode.source_report_id
      AND report.target_user_id = episode.target_user_id) AS "sourceMatches",
    (SELECT count(*) FROM moderation.moderation_actions action WHERE action.restriction_episode_id = episode.id
      AND action.actor_type = 'system' AND action.action_type = 'restrict_user'
      AND action.target_user_id = episode.target_user_id AND action.source_report_id = episode.source_report_id) = 1 AS "hasOneSystemAction"
    FROM moderation.restriction_episodes episode
`,
  support_threads: sql`
SELECT thread.id, thread.status <> 'open' OR limits."withinLimit" AS "withinLimit",
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
    LEFT JOIN LATERAL (
      SELECT (SELECT count(*) FROM (
      SELECT message.id FROM support.support_messages message
      JOIN support.support_threads owned ON owned.id = message.support_thread_id
      WHERE thread.status = 'open' AND owned.user_id = thread.user_id AND owned.status = 'open' AND message.sender_type = 'user'
        AND NOT EXISTS (SELECT 1 FROM support.support_messages reply
          JOIN support.support_threads replied ON replied.id = reply.support_thread_id
          WHERE replied.user_id = thread.user_id AND reply.sender_type = 'admin'
            AND (reply.created_at, reply.id) >= (message.created_at, message.id))
      LIMIT 3
    ) unanswered) <= 2 AS "withinLimit" OFFSET 0
    ) limits ON true
`,
  appeals: sql`
SELECT appeal.id, NOT EXISTS (SELECT 1 FROM moderation.user_appeals duplicate
      WHERE duplicate.ban_state_history_id = appeal.ban_state_history_id AND duplicate.id <> appeal.id) AS "uniqueBan", EXISTS (SELECT 1 FROM identity.account_state_history ban WHERE ban.id = appeal.ban_state_history_id
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
`,
  admins: sql`
SELECT admin.id, NOT admin.is_active OR (admin.identity_verified_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM identity.telegram_identities identity WHERE identity.user_id = admin.user_id
        AND identity.telegram_user_id = admin.telegram_user_id)) AS "identityMatches"
    FROM administration.admin_users admin
`,
  admin_logs: sql`
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
`,
  internal_blocks: sql`
SELECT pair.user_low_id AS "lowId", pair.user_high_id AS "highId",
      NOT EXISTS (SELECT 1 FROM matching.matches match WHERE match.user_low_id = pair.user_low_id
        AND match.user_high_id = pair.user_high_id AND (match.status = 'active' OR EXISTS (
          SELECT 1 FROM chat.chat_sessions session WHERE session.match_id = match.id AND session.status = 'active')))
      AND NOT EXISTS (SELECT 1 FROM interaction.likes like_row WHERE like_row.status = 'active' AND (
        (like_row.sender_user_id = pair.user_low_id AND like_row.receiver_user_id = pair.user_high_id)
        OR (like_row.sender_user_id = pair.user_high_id AND like_row.receiver_user_id = pair.user_low_id)))
      AND NOT EXISTS (SELECT 1 FROM matching.matches match
        JOIN interaction.feature_unlocks unlock ON unlock.match_id = match.id
        WHERE match.user_low_id = pair.user_low_id AND match.user_high_id = pair.user_high_id
          AND unlock.status = 'active' AND unlock.feature_type = 'chat_unlock')
      AND NOT EXISTS (SELECT 1 FROM interaction.likes like_row
        JOIN interaction.feature_unlocks unlock ON unlock.like_id = like_row.id
        WHERE unlock.status = 'active' AND unlock.feature_type = 'liked_by_profile_unlock' AND (
          (like_row.sender_user_id = pair.user_low_id AND like_row.receiver_user_id = pair.user_high_id)
          OR (like_row.sender_user_id = pair.user_high_id AND like_row.receiver_user_id = pair.user_low_id))) AS closed
    FROM interaction.user_pair_states pair WHERE pair.state = 'blocked'
`,
} as const;
export const MODERATION_INTEGRITY_FLAGS: Readonly<
  Record<ModerationReconciliationPhase, readonly string[]>
> = {
  reports: ['hasEvidence'],
  evidence: ['hasCapture', 'hasRetainedPhoto'],
  reviews: ['stateMatches', 'hasDecisionEvidence'],
  actions: ['hasAudit', 'hasAttempt', 'hasAccountHistory', 'hasNotice', 'reportMatches'],
  episodes: ['sourceMatches', 'hasOneSystemAction'],
  support_threads: ['withinLimit', 'hasAttempts'],
  appeals: ['banMatches', 'hasReview', 'unbanMatches', 'uniqueBan'],
  admins: ['identityMatches'],
  admin_logs: ['hasAccess', 'hasAction'],
  internal_blocks: ['closed'],
};
