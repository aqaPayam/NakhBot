import { sql, type RawBuilder } from 'kysely';
import type { ModerationReconciliationPhase } from '@nakh/application';
/** System restoration has no administrator prior-state authority. Exact admission
 * tuples form one membership set instead of repeated correlated history probes.
 * Unsupported account actions and null tuple fields still fail closed. */
function systemAccountHistoryMatches(): RawBuilder<boolean> {
  return sql<boolean>`COALESCE((action.target_user_id, action.reason_code, action.occurred_at,
      CASE action.action_type WHEN 'restrict_user' THEN 'restricted'
        WHEN 'ban_user' THEN 'banned' ELSE NULL::text END) IN (
    SELECT history.user_id, history.reason_code, history.changed_at, history.next_state
    FROM identity.account_state_history history
    WHERE history.actor_type = 'system' AND history.actor_admin_id IS NULL
      AND history.next_state IN ('restricted','banned')
  ),false)`;
}

/** Admission and restoration use disjoint exact membership sets. Admission does
 * not carry a synthetic previous-state column through a combined history hash.
 * Restoration still binds both states, including duplicate valid/invalid histories. */
function adminAccountHistoryMatches(): RawBuilder<boolean> {
  return sql<boolean>`COALESCE(CASE WHEN action.action_type IN ('restrict_user','ban_user') THEN
    (action.target_user_id, action.actor_admin_id, action.reason_code,
      action.occurred_at, CASE action.action_type WHEN 'restrict_user' THEN 'restricted'
        ELSE 'banned' END) IN (
    SELECT history.user_id, history.actor_admin_id, history.reason_code, history.changed_at,
      history.next_state FROM identity.account_state_history history
      WHERE history.actor_type = 'admin' AND history.actor_admin_id IS NOT NULL
        AND history.next_state IN ('restricted','banned')
    ) ELSE (action.target_user_id, action.actor_admin_id, action.reason_code,
      action.occurred_at, CASE action.action_type WHEN 'restrict_user' THEN 'restricted'
        WHEN 'ban_user' THEN 'banned' ELSE restoration.previous_state END,
      CASE action.action_type WHEN 'unrestrict_user' THEN 'restricted'
        WHEN 'unban_user' THEN 'banned' ELSE 'any' END) IN (
    SELECT history.user_id, history.actor_admin_id, history.reason_code, history.changed_at,
      history.next_state, history.previous_state FROM identity.account_state_history history
      WHERE history.actor_type = 'admin' AND history.actor_admin_id IS NOT NULL
        AND history.previous_state IN ('restricted','banned')
  ) END,false)`;
}

/** One actor-aware scan shares report and notice membership work across both actors.
 * System restrictions never gain administrator attempt/restoration authority.
 * Audit candidates are narrowed to the exact actor class. Pair-target membership
 * remains independent, so a wrong audit actor cannot hide valid attempt evidence.
 * Every original owner/request/command and notice/history binding remains exact. */
function moderationActionSource(): RawBuilder<unknown> {
  return sql`
SELECT action.id, COALESCE(action_audit.id IS NOT NULL
        AND CASE WHEN action.actor_type = 'system' THEN action_audit.actor_admin_id IS NULL
          ELSE action_audit.actor_admin_id = action.actor_admin_id END
        AND action_audit.command_id = action.command_id AND action_audit.request_id = action.request_id,
      false) AS "hasAudit",
    CASE WHEN action.actor_type = 'system' THEN true ELSE COALESCE(attempt.id IS NOT NULL
        AND attempt.request_id = action.request_id AND attempt.request_digest = action.request_digest
        AND attempt.result = 'succeeded'
        AND ((action.action_type = 'unban_user'
          AND attempt.command_code = 'moderation.unban-appeal' AND attempt.target_type = 'user_appeal'
          AND (action.id,attempt.id,attempt.target_id) IN (
            SELECT unban.action_id,unban.admin_action_log_id,unban.appeal_id FROM moderation.appeal_unbans unban))
          OR (action.action_type IN ('restrict_user','unrestrict_user','ban_user','unban_user')
            AND attempt.command_code = 'moderation.apply-account-action' AND attempt.target_type = 'user'
            AND attempt.target_id = action.target_user_id)
          OR (action.action_type IN ('hide_photo','restore_photo','delete_photo')
            AND attempt.command_code = 'moderation.apply-photo-action' AND attempt.target_type = 'photo'
            AND attempt.target_id = action.target_photo_id)
          OR (action.action_type = 'dismiss_report' AND attempt.command_code = 'moderation.decide-review'
            AND attempt.target_type = 'moderation_review' AND (attempt.target_id,action.source_report_id) IN (
              SELECT review.id,review.report_id FROM moderation.moderation_reviews review))
          OR (action.action_type IN ('create_internal_block','remove_internal_block')
            AND attempt.command_code = 'moderation.change-internal-block' AND attempt.target_type = 'user_pair'
            AND attempt.target_id = moderation.admin_pair_target_id(action.target_pair_low_user_id, action.target_pair_high_user_id)
            AND (action.audit_log_id,attempt.target_id) IN (
              SELECT audit.id,audit.subject_id FROM platform.audit_logs audit WHERE audit.subject_type = 'user_pair'))),false) END
      AS "hasAttempt",
      action.action_type NOT IN ('restrict_user','unrestrict_user','ban_user','unban_user') OR
      CASE WHEN action.actor_type = 'system' THEN ${systemAccountHistoryMatches()}
        ELSE ${adminAccountHistoryMatches()} END
      AS "hasAccountHistory",
    action.action_type NOT IN ('restrict_user','unrestrict_user','ban_user','unban_user')
      OR COALESCE((action.notification_id, action.target_user_id,
        CASE action.action_type WHEN 'restrict_user' THEN 'restriction_warning'
          WHEN 'ban_user' THEN 'ban_warning' ELSE 'admin_notice' END) IN (
        SELECT notice.id, notice.user_id, notice.notification_type
        FROM notification.notifications notice WHERE notice.payload = '{}'::jsonb
        UNION ALL
        SELECT notice.id,notice.user_id,notice.notification_type FROM notification.archived_notice_facts notice
          WHERE notice.empty_payload
      ),false) AS "hasNotice",
    action.source_report_id IS NULL OR (source_report.id IS NOT NULL
        AND ((action.action_type IN ('create_internal_block','remove_internal_block')
            AND LEAST(source_report.reporter_user_id, source_report.target_user_id) = action.target_pair_low_user_id
            AND GREATEST(source_report.reporter_user_id, source_report.target_user_id) = action.target_pair_high_user_id)
          OR source_report.target_user_id = action.target_user_id OR EXISTS (
          SELECT 1 FROM media.photo_reference_anchors photo JOIN profile.profile_reference_anchors profile ON profile.id = photo.profile_id
          WHERE photo.id = action.target_photo_id AND profile.user_id = source_report.target_user_id))
    ) AS "reportMatches"
    FROM moderation.moderation_actions action
    LEFT JOIN platform.audit_logs action_audit ON action_audit.id = action.audit_log_id
      AND action_audit.actor_type = action.actor_type
    LEFT JOIN moderation.reports source_report ON source_report.id = action.source_report_id
    LEFT JOIN administration.admin_action_logs attempt
      ON action.actor_type = 'admin'
        AND attempt.admin_user_id = action.actor_admin_id AND attempt.command_id = action.command_id
    -- One latest prior-state lookup per restoration binding; OFFSET 0 preserves the
    -- parameterized relation so repeated target/type/time bindings can be memoized.
    LEFT JOIN LATERAL (
      SELECT prior.previous_state FROM identity.account_state_history prior
      WHERE action.actor_type = 'admin' AND action.action_type IN ('unrestrict_user','unban_user')
        AND prior.user_id = action.target_user_id
        AND prior.next_state = CASE action.action_type WHEN 'unrestrict_user' THEN 'restricted' ELSE 'banned' END
        AND prior.changed_at <= action.occurred_at
        AND (action.action_type <> 'unrestrict_user' OR prior.previous_state <> 'banned')
      ORDER BY prior.changed_at DESC, prior.id DESC LIMIT 1 OFFSET 0
    ) restoration ON true
`;
}

export const MODERATION_EPISODE_RESOLUTION_FACTS = sql`WITH resolution_facts AS MATERIALIZED (
    -- Keep one explicit fact per resolved owner, including failed bindings. An
    -- indexed existence probe retains every binding without a wide intermediate
    -- CTE, tuple hash or grouping duplicate attempts per owner.
    SELECT owner.id AS restriction_episode_id,
      EXISTS (
        SELECT 1 FROM LATERAL (
          SELECT actor_admin_id, command_id, request_id, request_digest
          FROM moderation.moderation_actions
          WHERE restriction_episode_id = owner.id AND restriction_episode_id IS NOT NULL
            AND actor_type = 'admin' AND action_type = 'unrestrict_user'
            AND target_user_id = owner.target_user_id
            AND reason_code = owner.resolution_reason_code AND occurred_at = owner.resolved_at OFFSET 0
        ) resolution
        JOIN administration.admin_action_logs attempt
          ON attempt.admin_user_id = resolution.actor_admin_id
          AND attempt.command_id = resolution.command_id
          AND attempt.request_id = resolution.request_id
          AND attempt.request_digest = resolution.request_digest
          AND attempt.target_id = owner.target_user_id
        WHERE resolution.actor_admin_id = owner.resolved_by_admin_id
          AND attempt.result = 'succeeded'
          AND attempt.command_code = 'moderation.apply-account-action' AND attempt.target_type = 'user'
      ) AS valid
    FROM moderation.restriction_episodes owner WHERE owner.status = 'resolved'
)
`;

function thresholdActionBinding(): RawBuilder<boolean> {
  return sql<boolean>`COALESCE(action.id IS NOT NULL AND action.actor_admin_id IS NULL
    AND action.target_user_id = episode.target_user_id AND action.source_report_id = episode.source_report_id
    AND action.reason_code = 'distinct_reporter_threshold'
    AND action.occurred_at = date_trunc('milliseconds',episode.started_at),false)`;
}

/** Complete scanner flags; aggregate callers can supply an already resolution-valid scope. */
export function moderationEpisodeMetadataSource(eligibleOnly = false): RawBuilder<unknown> {
  return sql`SELECT episode.id, EXISTS (SELECT 1 FROM moderation.reports report WHERE report.id = episode.source_report_id
      AND report.target_user_id = episode.target_user_id) AS "sourceMatches",
    episode.witness_required AS "witnessRequired",
    COALESCE(episode.witness_required AND witness."count" = episode.distinct_reporter_count
      AND witness."bindingsValid",false) AS "hasAdmissionWitness",
    ${thresholdActionBinding()} AS "hasOneSystemAction",
    NOT ${thresholdActionBinding()} OR COALESCE((episode.target_user_id,action.occurred_at) IN (
      SELECT history.user_id,history.changed_at FROM identity.account_state_history history
      WHERE history.actor_type = 'system' AND history.actor_user_id IS NULL AND history.actor_admin_id IS NULL
        AND history.previous_state IN ('guest','incomplete','active') AND history.next_state = 'restricted'
        AND history.reason_code = 'distinct_reporter_threshold'
    ),false) AS "hasRestrictionHistory",
    NOT ${thresholdActionBinding()} OR COALESCE(restriction_audit.id IS NOT NULL
      AND restriction_audit.category = 'security' AND restriction_audit.event_type = 'moderation.threshold-restriction.v1'
      AND restriction_audit.actor_type = 'system' AND restriction_audit.actor_admin_id IS NULL AND restriction_audit.actor_user_id IS NULL
      AND restriction_audit.subject_type = 'user' AND restriction_audit.subject_id = episode.target_user_id
      AND restriction_audit.result_code = 'restricted' AND restriction_audit.metadata_schema_version = 1
      AND restriction_audit.metadata = expected_audit.metadata
      AND restriction_audit.command_id = action.command_id AND restriction_audit.request_id = action.request_id
      AND restriction_audit.occurred_at = action.occurred_at,false) AS "hasRestrictionAudit",
    NOT ${thresholdActionBinding()} OR COALESCE(restriction_notice.id IS NOT NULL
      AND restriction_notice.user_id = episode.target_user_id AND restriction_notice.notification_type = 'restriction_warning'
      AND restriction_notice.category = 'restriction' AND restriction_notice.title_key = 'notification.restriction_warning.title'
      AND restriction_notice.body_key = 'notification.restriction_warning.body' AND restriction_notice.payload = '{}'::jsonb
      AND restriction_notice.payload_schema_version = 1
      AND restriction_notice.deduplication_key = 'moderation-threshold:' || episode.id::text || ':restriction'
      AND telegram_delivery.notification_id IS NOT NULL,false) OR EXISTS(
        SELECT 1 FROM notification.archived_notice_facts archived WHERE archived.id=action.notification_id
          AND archived.user_id=episode.target_user_id AND archived.notification_type='restriction_warning'
          AND archived.empty_payload AND archived.threshold_episode_id=episode.id
      ) AS "hasRestrictionNotice",
    ${eligibleOnly ? sql`true` : sql`episode.status <> 'resolved' OR COALESCE(resolution_binding.valid,false)`} AS "hasResolutionAttempt"
    FROM ${eligibleOnly ? sql`eligible_episodes` : sql`moderation.restriction_episodes`} episode
    ${eligibleOnly ? sql`` : sql`LEFT JOIN resolution_facts resolution_binding ON resolution_binding.restriction_episode_id = episode.id`}
    LEFT JOIN (
      SELECT roster.restriction_episode_id, count(*) AS "count",
        bool_and((report.id IS NOT NULL AND report.reporter_user_id = roster.reporter_user_id
          AND report.target_user_id = owner.target_user_id AND report.submitted_at = roster.submitted_at
          AND roster.submitted_at > owner.started_at - interval '30 days'
          AND roster.submitted_at <= owner.started_at) IS TRUE) AS "bindingsValid"
      FROM moderation.threshold_admission_witnesses roster
      JOIN ${eligibleOnly ? sql`eligible_episodes` : sql`moderation.restriction_episodes`} owner
        ON owner.id = roster.restriction_episode_id
      LEFT JOIN moderation.reports report ON report.id = roster.report_id
      GROUP BY roster.restriction_episode_id
    ) witness ON witness.restriction_episode_id = episode.id
    -- The partial unique episode key identifies one candidate. Exact actor/owner,
    -- Report, reason and timestamp fields remain in the binding flag above; a bad
    -- candidate has the same downstream flags as the original missing binding.
    LEFT JOIN moderation.moderation_actions action ON action.restriction_episode_id = episode.id
        AND action.actor_type = 'system' AND action.action_type = 'restrict_user'
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('reasonCode','distinct_reporter_threshold',
        'distinctReporterCount',episode.distinct_reporter_count) AS metadata OFFSET 0
    ) expected_audit ON true
    -- Primary keys give one candidate each. Validate every metadata/content-free binding
    -- in its flag instead of hashing wide tuples and rebuilding expected JSON in join keys.
    -- Unique physical references identify candidates; validate all safety fields
    -- in the flags above. Selective constants here can underestimate candidates
    -- and cause a repeated materialized audit scan for each episode.
    LEFT JOIN platform.audit_logs restriction_audit ON restriction_audit.id = action.audit_log_id
    LEFT JOIN notification.notifications restriction_notice ON restriction_notice.id = action.notification_id
    LEFT JOIN (SELECT DISTINCT notification_id FROM notification.notification_deliveries WHERE channel = 'telegram')
      telegram_delivery ON telegram_delivery.notification_id = restriction_notice.id
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
          hold.photo_id = evidence.profile_photo_id AND variant.variant_id IS NOT NULL
          AND variant.asset_id = hold.asset_id
          AND variant.variant_type = 'thumbnail' AND variant.transformation_version = 1
          AND encode(variant.sha256, 'hex') = hold.content_sha256,
          false) AS "hasRetainedPhoto"
      FROM moderation.report_evidence evidence
      LEFT JOIN moderation.report_snapshots snapshot ON snapshot.report_evidence_id = evidence.id
        AND snapshot.report_id = evidence.report_id AND snapshot.snapshot_type = evidence.evidence_type
        AND snapshot.metadata_shape_valid
      LEFT JOIN media.report_photo_evidence_holds hold ON hold.report_evidence_id = evidence.id
      -- The owning view independently verifies either live original bytes or the
      -- audited private copy. Ordinary source archival must not hide custody;
      -- missing or corrupt private proof still yields no matching source.
      LEFT JOIN media.report_photo_source_facts variant
        ON variant.report_evidence_id = evidence.id AND variant.variant_id = hold.variant_id
        AND variant.asset_id = hold.asset_id
      WHERE evidence.evidence_type = 'photo'
`,
  reviews: sql`
SELECT review.id, COALESCE(report.id IS NOT NULL AND (
      (review.status IN ('pending','in_review') AND report.status = 'pending_review')
      OR (review.status IN ('dismissed','actioned') AND report.status = review.status)
    ),false) AS "stateMatches",
    review.status NOT IN ('dismissed','actioned') OR EXISTS (
      SELECT 1 FROM moderation.moderation_actions action WHERE action.source_report_id = review.report_id
        AND action.actor_type = 'admin'
        AND ((review.status = 'dismissed' AND action.action_type = 'dismiss_report')
          OR (review.status = 'actioned' AND action.action_type <> 'dismiss_report'))
    ) AS "hasDecisionEvidence"
    FROM moderation.moderation_reviews review
    LEFT JOIN moderation.reports report ON report.id = review.report_id
`,
  actions: moderationActionSource(),
  episodes: sql`${MODERATION_EPISODE_RESOLUTION_FACTS}${moderationEpisodeMetadataSource()}`,
  support_threads: sql`
WITH latest_reply AS MATERIALIZED (
    -- The owning admission path uses this same lexicographic latest-message boundary.
    -- Replies from closed threads still answer earlier messages across the User's threads.
    SELECT DISTINCT ON (owned.user_id,owned.product_epoch) owned.user_id, owned.product_epoch, message.created_at, message.id
    FROM support.support_messages message
    JOIN support.support_threads owned ON owned.id = message.support_thread_id
    WHERE message.sender_type = 'admin'
    ORDER BY owned.user_id, owned.product_epoch, message.created_at DESC, message.id DESC
), unanswered AS MATERIALIZED (
    SELECT owned.user_id, owned.product_epoch, count(*) AS count FROM support.support_messages message
    JOIN support.support_threads owned ON owned.id = message.support_thread_id
    LEFT JOIN latest_reply reply ON reply.user_id = owned.user_id AND reply.product_epoch = owned.product_epoch
    WHERE owned.status = 'open' AND message.sender_type = 'user'
      AND (reply.id IS NULL OR (message.created_at,message.id) > (reply.created_at,reply.id))
    GROUP BY owned.user_id, owned.product_epoch
), deletion_closures AS MATERIALIZED (
    -- Only actual retained closures need native proof verification. Evaluating
    -- the scalar proof for every ordinarily closed thread repeats empty lookups.
    SELECT proof.support_thread_id, proof.source_version, true AS valid
    FROM support.verified_deletion_thread_closures proof
), reply_attempts AS MATERIALIZED (
    SELECT message.support_thread_id, bool_and(COALESCE(attempt.id IS NOT NULL
      AND attempt.request_id = message.request_id AND attempt.request_digest = message.request_digest
      AND attempt.command_code = 'support.reply-thread' AND attempt.target_type = 'support_thread'
      AND attempt.target_id = message.support_thread_id AND attempt.result = 'succeeded'
      AND attempt.expected_target_version = message.thread_version_after - 1,false)) AS valid
    FROM support.support_messages message
    LEFT JOIN administration.admin_action_logs attempt
      ON attempt.admin_user_id = message.sender_admin_id AND attempt.command_id = message.command_id
    WHERE message.sender_type = 'admin' GROUP BY message.support_thread_id
)
SELECT thread.id, thread.status <> 'open' OR COALESCE(unanswered.count,0) <= 2 AS "withinLimit",
    COALESCE(reply_attempts.valid,true) AND (thread.status <> 'closed' OR COALESCE(
      (thread.id,thread.version - 1) IN (
        SELECT attempt.target_id,attempt.expected_target_version FROM administration.admin_action_logs attempt
        WHERE attempt.command_code = 'support.close-thread' AND attempt.target_type = 'support_thread'
          AND attempt.result = 'succeeded'
      ),false) OR COALESCE(deletion_closures.valid,false)) AS "hasAttempts"
    FROM support.support_threads thread
    LEFT JOIN unanswered ON unanswered.user_id = thread.user_id AND unanswered.product_epoch = thread.product_epoch
    LEFT JOIN reply_attempts ON reply_attempts.support_thread_id = thread.id
    LEFT JOIN deletion_closures ON deletion_closures.support_thread_id = thread.id
      AND deletion_closures.source_version = thread.version - 1
`,
  appeals: sql`
WITH unban_facts AS MATERIALIZED (
    -- Evaluate the uniquely owned link/effect facts once, independently of Appeal joins.
    SELECT unban.appeal_id, action.target_user_id,
      COALESCE(action.id IS NOT NULL AND action.action_type = 'unban_user'
        AND history.id IS NOT NULL AND history.user_id = action.target_user_id
        AND history.previous_state = 'banned' AND history.actor_admin_id = action.actor_admin_id
        AND history.changed_at = action.occurred_at
        AND attempt.id IS NOT NULL AND attempt.admin_user_id = action.actor_admin_id
        AND attempt.command_id = action.command_id AND attempt.command_code = 'moderation.unban-appeal'
        AND attempt.target_type = 'user_appeal' AND attempt.target_id = unban.appeal_id
        AND attempt.result = 'succeeded',false) AS valid
    FROM moderation.appeal_unbans unban
    -- Each immutable primary key gives one candidate. Check every owner/effect
    -- binding in the fact instead of carrying wide compound keys through hashes.
    LEFT JOIN moderation.moderation_actions action ON action.id = unban.action_id
    LEFT JOIN identity.account_state_history history ON history.id = unban.unban_history_id
    LEFT JOIN administration.admin_action_logs attempt ON attempt.id = unban.admin_action_log_id
)
SELECT appeal.id, ban_population."count" = 1 AS "uniqueBan",
    ban.id IS NOT NULL AS "banMatches",
    appeal.status NOT IN ('accepted','rejected') OR COALESCE(
      (appeal.id,appeal.reviewed_by_admin_id,appeal.version - 1,
        CASE appeal.status WHEN 'accepted' THEN 'appeal_accepted' ELSE 'appeal_rejected' END) IN (
        -- Exact tuple membership retains EXISTS semantics for duplicate attempts/audits
        -- without sorting and grouping both terminal outcomes for every review.
        SELECT attempt.target_id,attempt.admin_user_id,attempt.expected_target_version,audit.result_code
        FROM administration.admin_action_logs attempt JOIN platform.audit_logs audit
          ON audit.command_id = attempt.command_id AND audit.actor_admin_id = attempt.admin_user_id
          AND audit.subject_type = 'user_appeal' AND audit.subject_id = attempt.target_id
          AND audit.event_type = 'moderation.appeal-reviewed.v1' AND audit.request_id = attempt.request_id
        WHERE attempt.target_type = 'user_appeal' AND attempt.command_code = 'moderation.review-appeal'
          AND attempt.result = 'succeeded'
      ),false) AS "hasReview",
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
        OR COALESCE(effect.id IS NOT NULL AND effect.actor_admin_id = attempt.admin_user_id
          AND effect.request_id = attempt.request_id
          AND effect.request_digest = attempt.request_digest,false) AS "hasAction"
    FROM administration.admin_action_logs attempt
    -- The physical unique command key gives at most one candidate. Compare every
    -- owner/request/digest binding after lookup rather than hashing the wide tuple.
    LEFT JOIN moderation.moderation_actions effect ON effect.command_id = attempt.command_id
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
