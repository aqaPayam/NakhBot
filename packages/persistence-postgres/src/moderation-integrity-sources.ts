import { sql, type RawBuilder } from 'kysely';
import type { ModerationReconciliationPhase } from '@nakh/application';
/** Split null and exact administrator bindings so PostgreSQL can use the actor/history index. */
function accountHistoryMatches(
  adminMatches: RawBuilder<unknown>,
  restoredState: RawBuilder<unknown>,
): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (
      SELECT 1 FROM identity.account_state_history history WHERE history.user_id = action.target_user_id
        AND history.actor_type = action.actor_type AND ${adminMatches}
        AND history.reason_code = action.reason_code AND history.changed_at = action.occurred_at
        AND ((action.action_type = 'restrict_user' AND history.next_state = 'restricted')
          OR (action.action_type = 'ban_user' AND history.next_state = 'banned')
          OR (action.action_type IN ('unrestrict_user','unban_user')
            AND history.previous_state = CASE action.action_type WHEN 'unrestrict_user' THEN 'restricted' ELSE 'banned' END
            AND history.next_state = ${restoredState}))
    )`;
}

/** Disjoint actor branches keep system restrictions out of administrator attempt/restoration joins.
 * The persisted actor CHECK makes the two branches exhaustive, with one row per action. */
function moderationActionSource(actor: 'system' | 'admin'): RawBuilder<unknown> {
  const isSystem = actor === 'system';
  return sql`
SELECT action.id, COALESCE(bound_audit.id IS NOT NULL
    AND bound_audit.actor_type = action.actor_type
    AND ${isSystem ? sql`bound_audit.actor_admin_id IS NULL` : sql`bound_audit.actor_admin_id = action.actor_admin_id`}
    AND bound_audit.command_id = action.command_id AND bound_audit.request_id = action.request_id,false) AS "hasAudit",
    ${
      isSystem
        ? sql`true`
        : sql`COALESCE(attempt.id IS NOT NULL
        AND attempt.request_id = action.request_id AND attempt.request_digest = action.request_digest
        AND attempt.result = 'succeeded'
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
              AND audit.subject_type = 'user_pair' AND audit.subject_id = attempt.target_id))),false)`
    } AS "hasAttempt",
    ${
      isSystem
        ? sql`history_binding."hasAccountHistory"`
        : sql`
      action.action_type NOT IN ('restrict_user','unrestrict_user','ban_user','unban_user') OR
      ${accountHistoryMatches(sql`history.actor_admin_id = action.actor_admin_id`, sql`restoration.previous_state`)}
    `
    } AS "hasAccountHistory",
    action.action_type NOT IN ('restrict_user','unrestrict_user','ban_user','unban_user')
      OR COALESCE(bound_notice.id IS NOT NULL AND bound_notice.user_id = action.target_user_id
        AND bound_notice.payload = '{}'::jsonb
        AND bound_notice.notification_type = CASE action.action_type WHEN 'restrict_user' THEN 'restriction_warning'
          WHEN 'ban_user' THEN 'ban_warning' ELSE 'admin_notice' END,false) AS "hasNotice",
    action.source_report_id IS NULL OR (source_report.id IS NOT NULL
        AND ((action.action_type IN ('create_internal_block','remove_internal_block')
            AND LEAST(source_report.reporter_user_id, source_report.target_user_id) = action.target_pair_low_user_id
            AND GREATEST(source_report.reporter_user_id, source_report.target_user_id) = action.target_pair_high_user_id)
          OR source_report.target_user_id = action.target_user_id OR EXISTS (
          SELECT 1 FROM media.profile_photos photo JOIN profile.profiles profile ON profile.id = photo.profile_id
          WHERE photo.id = action.target_photo_id AND profile.user_id = source_report.target_user_id))
    ) AS "reportMatches"
    FROM moderation.moderation_actions action
    LEFT JOIN moderation.reports source_report ON source_report.id = action.source_report_id
    ${
      isSystem
        ? sql`LEFT JOIN LATERAL (
          SELECT action.action_type NOT IN ('restrict_user','unrestrict_user','ban_user','unban_user') OR
            ${accountHistoryMatches(sql`history.actor_admin_id IS NULL`, sql`NULL::text`)} AS "hasAccountHistory"
          OFFSET 0
        ) history_binding ON true`
        : sql`    LEFT JOIN administration.admin_action_logs attempt
      ON attempt.admin_user_id = action.actor_admin_id AND attempt.command_id = action.command_id
    -- One latest prior-state lookup per restoration binding; OFFSET 0 preserves the
    -- parameterized relation so repeated target/type/time bindings can be memoized.
    LEFT JOIN LATERAL (
      SELECT prior.previous_state FROM identity.account_state_history prior
      WHERE action.action_type IN ('unrestrict_user','unban_user')
        AND prior.user_id = action.target_user_id
        AND prior.next_state = CASE action.action_type WHEN 'unrestrict_user' THEN 'restricted' ELSE 'banned' END
        AND prior.changed_at <= action.occurred_at
        AND (action.action_type <> 'unrestrict_user' OR prior.previous_state <> 'banned')
      ORDER BY prior.changed_at DESC, prior.id DESC LIMIT 1 OFFSET 0
    ) restoration ON true`
    }
    -- Primary/unique keys identify one candidate. Every safety binding remains in
    -- its flag rather than becoming an additional hash key for this lookup.
    LEFT JOIN platform.audit_logs bound_audit ON bound_audit.id = action.audit_log_id
    LEFT JOIN notification.notifications bound_notice ON bound_notice.id = action.notification_id
    WHERE action.actor_type = ${actor}
`;
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
        ) ELSE snapshot.id IS NOT NULL END AS "hasCapture",
        true AS "hasRetainedPhoto"
      FROM moderation.report_evidence evidence
      LEFT JOIN moderation.report_snapshots snapshot ON snapshot.report_evidence_id = evidence.id
        AND snapshot.report_id = evidence.report_id AND snapshot.snapshot_type = evidence.evidence_type
        AND snapshot.snapshot_type <> 'photo'
        AND snapshot.metadata_shape_valid
      WHERE evidence.evidence_type <> 'photo'
      UNION ALL
SELECT evidence.id, evidence.report_id AS "reportId", evidence.evidence_type AS "evidenceType",
        snapshot.id IS NOT NULL AS "hasCapture", COALESCE(
          hold.photo_id = evidence.profile_photo_id AND variant.id IS NOT NULL AND asset.id IS NOT NULL
          AND variant.variant_type = 'thumbnail' AND variant.transformation_version = 1
          AND encode(variant.sha256, 'hex') = hold.content_sha256
          AND variant.storage_deleted_at IS NULL AND asset.storage_deleted_at IS NULL,
          false) AS "hasRetainedPhoto"
      FROM moderation.report_evidence evidence
      LEFT JOIN moderation.report_snapshots snapshot ON snapshot.report_evidence_id = evidence.id
        AND snapshot.report_id = evidence.report_id AND snapshot.snapshot_type = evidence.evidence_type
        AND snapshot.metadata_shape_valid
      LEFT JOIN media.report_photo_evidence_holds hold ON hold.report_evidence_id = evidence.id
      LEFT JOIN media.photo_variants variant ON variant.id = hold.variant_id AND variant.asset_id = hold.asset_id
      LEFT JOIN media.media_assets asset ON asset.id = hold.asset_id
      WHERE evidence.evidence_type = 'photo'
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
  actions: sql`(${moderationActionSource('system')}) UNION ALL (${moderationActionSource('admin')})`,
  episodes: sql`
WITH resolution_facts AS MATERIALIZED (
    SELECT owner.id AS restriction_episode_id FROM moderation.restriction_episodes owner
    JOIN LATERAL (
      -- Enumerate indexed candidates; validate every attempt before grouping existence.
      SELECT resolution.actor_admin_id, resolution.command_id, resolution.request_id, resolution.request_digest
      FROM moderation.moderation_actions resolution
      WHERE resolution.restriction_episode_id = owner.id AND resolution.action_type = 'unrestrict_user'
        AND resolution.actor_type = 'admin' AND resolution.actor_admin_id = owner.resolved_by_admin_id
        AND resolution.target_user_id = owner.target_user_id AND resolution.reason_code = owner.resolution_reason_code
        AND resolution.occurred_at = owner.resolved_at
      OFFSET 0
    ) resolution ON true
    JOIN administration.admin_action_logs attempt ON attempt.admin_user_id = resolution.actor_admin_id
      AND attempt.command_id = resolution.command_id AND attempt.request_id = resolution.request_id
      AND attempt.request_digest = resolution.request_digest AND attempt.result = 'succeeded'
      AND attempt.command_code = 'moderation.apply-account-action' AND attempt.target_type = 'user'
      AND attempt.target_id = owner.target_user_id
    WHERE owner.status = 'resolved' GROUP BY owner.id
)
SELECT episode.id, EXISTS (SELECT 1 FROM moderation.reports report WHERE report.id = episode.source_report_id
      AND report.target_user_id = episode.target_user_id) AS "sourceMatches",
    episode.witness_required AS "witnessRequired",
    COALESCE(episode.witness_required AND witness."count" = episode.distinct_reporter_count
      AND witness."bindingsValid",false) AS "hasAdmissionWitness",
    action.id IS NOT NULL AS "hasOneSystemAction",
    action.id IS NULL OR history_binding.valid AS "hasRestrictionHistory",
    action.id IS NULL OR restriction_audit.id IS NOT NULL AS "hasRestrictionAudit",
    action.id IS NULL OR (restriction_notice.id IS NOT NULL AND telegram_delivery.notification_id IS NOT NULL) AS "hasRestrictionNotice",
    episode.status <> 'resolved' OR resolution_binding.restriction_episode_id IS NOT NULL AS "hasResolutionAttempt"
    FROM moderation.restriction_episodes episode
    LEFT JOIN resolution_facts resolution_binding ON resolution_binding.restriction_episode_id = episode.id
    LEFT JOIN (
      SELECT roster.restriction_episode_id, count(*) AS "count",
        bool_and((report.id IS NOT NULL AND report.reporter_user_id = roster.reporter_user_id
          AND report.target_user_id = owner.target_user_id AND report.submitted_at = roster.submitted_at
          AND roster.submitted_at > owner.started_at - interval '30 days'
          AND roster.submitted_at <= owner.started_at) IS TRUE) AS "bindingsValid"
      FROM moderation.threshold_admission_witnesses roster
      JOIN moderation.restriction_episodes owner ON owner.id = roster.restriction_episode_id
      LEFT JOIN moderation.reports report ON report.id = roster.report_id
      GROUP BY roster.restriction_episode_id
    ) witness ON witness.restriction_episode_id = episode.id
    -- The verified partial unique index guarantees at most one system restriction per episode.
    -- A direct join preserves that cardinality without repeating an aggregate for every episode.
    LEFT JOIN moderation.moderation_actions action ON action.restriction_episode_id = episode.id
        AND action.actor_type = 'system' AND action.actor_admin_id IS NULL AND action.action_type = 'restrict_user'
        AND action.target_user_id = episode.target_user_id AND action.source_report_id = episode.source_report_id
        AND action.reason_code = 'distinct_reporter_threshold'
        AND action.occurred_at = date_trunc('milliseconds',episode.started_at)
    LEFT JOIN LATERAL (
      SELECT EXISTS (SELECT 1 FROM identity.account_state_history history
        WHERE history.user_id = episode.target_user_id AND history.changed_at = action.occurred_at
          AND history.actor_type = 'system' AND history.actor_user_id IS NULL AND history.actor_admin_id IS NULL
          AND history.previous_state IN ('guest','incomplete','active') AND history.next_state = 'restricted'
          AND history.reason_code = 'distinct_reporter_threshold') AS valid OFFSET 0
    ) history_binding ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('reasonCode','distinct_reporter_threshold',
        'distinctReporterCount',episode.distinct_reporter_count) AS metadata OFFSET 0
    ) expected_audit ON true
    LEFT JOIN platform.audit_logs restriction_audit ON restriction_audit.id = action.audit_log_id
      AND restriction_audit.category = 'security' AND restriction_audit.event_type = 'moderation.threshold-restriction.v1'
      AND restriction_audit.actor_type = 'system' AND restriction_audit.actor_admin_id IS NULL AND restriction_audit.actor_user_id IS NULL
      AND restriction_audit.subject_type = 'user' AND restriction_audit.subject_id = episode.target_user_id
      AND restriction_audit.result_code = 'restricted' AND restriction_audit.metadata_schema_version = 1
      AND restriction_audit.metadata = expected_audit.metadata
      AND restriction_audit.command_id = action.command_id AND restriction_audit.request_id = action.request_id
      AND restriction_audit.occurred_at = action.occurred_at
    LEFT JOIN notification.notifications restriction_notice ON restriction_notice.id = action.notification_id
      AND restriction_notice.user_id = episode.target_user_id AND restriction_notice.notification_type = 'restriction_warning'
      AND restriction_notice.category = 'restriction' AND restriction_notice.title_key = 'notification.restriction_warning.title'
      AND restriction_notice.body_key = 'notification.restriction_warning.body' AND restriction_notice.payload = '{}'::jsonb
      AND restriction_notice.payload_schema_version = 1
      AND restriction_notice.deduplication_key = 'moderation-threshold:' || episode.id::text || ':restriction'
    LEFT JOIN (SELECT DISTINCT notification_id FROM notification.notification_deliveries WHERE channel = 'telegram')
      telegram_delivery ON telegram_delivery.notification_id = restriction_notice.id
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
WITH unban_facts AS MATERIALIZED (
    -- Evaluate the uniquely owned link/effect facts once, independently of Appeal joins.
    SELECT unban.appeal_id, action.target_user_id,
      (action.id IS NOT NULL AND history.id IS NOT NULL AND attempt.id IS NOT NULL) AS valid
    FROM moderation.appeal_unbans unban
    LEFT JOIN moderation.moderation_actions action ON action.id = unban.action_id AND action.action_type = 'unban_user'
    LEFT JOIN identity.account_state_history history ON history.id = unban.unban_history_id
      AND history.user_id = action.target_user_id AND history.previous_state = 'banned'
      AND history.actor_admin_id = action.actor_admin_id AND history.changed_at = action.occurred_at
    LEFT JOIN administration.admin_action_logs attempt ON attempt.id = unban.admin_action_log_id
      AND attempt.admin_user_id = action.actor_admin_id AND attempt.command_id = action.command_id
      AND attempt.command_code = 'moderation.unban-appeal' AND attempt.target_type = 'user_appeal'
      AND attempt.target_id = unban.appeal_id AND attempt.result = 'succeeded'
)
SELECT appeal.id, ban_population."count" = 1 AS "uniqueBan",
    ban.id IS NOT NULL AS "banMatches",
    appeal.status NOT IN ('accepted','rejected') OR COALESCE(
      CASE appeal.status WHEN 'accepted' THEN review.accepted ELSE review.rejected END,false) AS "hasReview",
    unban.appeal_id IS NULL OR COALESCE(appeal.status = 'accepted'
      AND unban.target_user_id = appeal.user_id AND unban.valid,false) AS "unbanMatches"
    FROM moderation.user_appeals appeal
    -- Non-null ban IDs and unique row IDs make count = 1 equivalent to no other
    -- Appeal for this event. One grouped fact avoids two probes per Appeal.
    JOIN (SELECT ban_state_history_id, count(*) AS "count" FROM moderation.user_appeals
      GROUP BY ban_state_history_id) ban_population ON ban_population.ban_state_history_id = appeal.ban_state_history_id
    -- The one-unban-per-Appeal primary key and effect primary keys retain one row.
    LEFT JOIN unban_facts unban ON unban.appeal_id = appeal.id
    LEFT JOIN identity.account_state_history ban ON ban.id = appeal.ban_state_history_id
      AND ban.user_id = appeal.user_id AND ban.next_state = 'banned'
    LEFT JOIN (
      -- Each exact actor/target/version fact retains both independent terminal outcomes.
      -- Matching duplicates retain EXISTS semantics and never duplicate an Appeal.
      SELECT attempt.target_id, attempt.admin_user_id, attempt.expected_target_version,
        bool_or(audit.result_code = 'appeal_accepted') AS accepted,
        bool_or(audit.result_code = 'appeal_rejected') AS rejected
      FROM administration.admin_action_logs attempt JOIN platform.audit_logs audit
        ON audit.command_id = attempt.command_id AND audit.actor_admin_id = attempt.admin_user_id
        AND audit.subject_type = 'user_appeal' AND audit.subject_id = attempt.target_id
        AND audit.event_type = 'moderation.appeal-reviewed.v1' AND audit.request_id = attempt.request_id
      WHERE attempt.target_type = 'user_appeal' AND attempt.command_code = 'moderation.review-appeal'
        AND attempt.result = 'succeeded'
      GROUP BY attempt.target_id, attempt.admin_user_id, attempt.expected_target_version
    ) review ON review.target_id = appeal.id AND review.admin_user_id = appeal.reviewed_by_admin_id
      AND review.expected_target_version = appeal.version - 1
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
      open_pair.user_low_id IS NULL AS closed
    FROM interaction.user_pair_states pair
    LEFT JOIN (
      SELECT facts.user_low_id, facts.user_high_id FROM (
        SELECT match.user_low_id, match.user_high_id FROM matching.matches match
        WHERE match.status = 'active' OR EXISTS (
          SELECT 1 FROM chat.chat_sessions session WHERE session.match_id = match.id AND session.status = 'active')
        UNION ALL
        SELECT LEAST(like_row.sender_user_id,like_row.receiver_user_id),
          GREATEST(like_row.sender_user_id,like_row.receiver_user_id)
        FROM interaction.likes like_row WHERE like_row.status = 'active'
        UNION ALL
        SELECT match.user_low_id, match.user_high_id FROM matching.matches match
        JOIN interaction.feature_unlocks unlock ON unlock.match_id = match.id
        WHERE unlock.status = 'active' AND unlock.feature_type = 'chat_unlock'
        UNION ALL
        SELECT LEAST(like_row.sender_user_id,like_row.receiver_user_id),
          GREATEST(like_row.sender_user_id,like_row.receiver_user_id)
        FROM interaction.likes like_row JOIN interaction.feature_unlocks unlock ON unlock.like_id = like_row.id
        WHERE unlock.status = 'active' AND unlock.feature_type = 'liked_by_profile_unlock'
      ) facts GROUP BY facts.user_low_id, facts.user_high_id
    ) open_pair ON open_pair.user_low_id = pair.user_low_id AND open_pair.user_high_id = pair.user_high_id
    WHERE pair.state = 'blocked'
`,
} as const;
export const MODERATION_INTEGRITY_FLAGS: Readonly<
  Record<ModerationReconciliationPhase, readonly string[]>
> = {
  reports: ['hasEvidence'],
  evidence: ['hasCapture', 'hasRetainedPhoto'],
  reviews: ['stateMatches', 'hasDecisionEvidence'],
  actions: ['hasAudit', 'hasAttempt', 'hasAccountHistory', 'hasNotice', 'reportMatches'],
  episodes: [
    'hasAdmissionWitness',
    'sourceMatches',
    'hasOneSystemAction',
    'hasRestrictionHistory',
    'hasRestrictionAudit',
    'hasRestrictionNotice',
    'hasResolutionAttempt',
  ],
  support_threads: ['withinLimit', 'hasAttempts'],
  appeals: ['banMatches', 'hasReview', 'unbanMatches', 'uniqueBan'],
  admins: ['identityMatches'],
  admin_logs: ['hasAccess', 'hasAction'],
  internal_blocks: ['closed'],
};
