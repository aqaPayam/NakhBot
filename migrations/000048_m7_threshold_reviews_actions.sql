CREATE TABLE moderation.restriction_episodes (
  id uuid PRIMARY KEY,
  target_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  source_report_id uuid NOT NULL REFERENCES moderation.reports(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
  distinct_reporter_count integer NOT NULL CHECK (distinct_reporter_count >= 5),
  started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  resolved_at timestamptz,
  resolved_by_admin_id uuid REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  resolution_reason_code text CHECK (
    resolution_reason_code IS NULL OR resolution_reason_code ~ '^[a-z][a-z0-9_]{0,79}$'
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT restriction_episode_state_ck CHECK (
    (status = 'active' AND resolved_at IS NULL AND resolved_by_admin_id IS NULL
      AND resolution_reason_code IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at >= started_at
      AND resolved_by_admin_id IS NOT NULL AND resolution_reason_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX restriction_episodes_one_active_target_idx
  ON moderation.restriction_episodes (target_user_id) WHERE status = 'active';
CREATE INDEX restriction_episodes_target_time_idx
  ON moderation.restriction_episodes (target_user_id, started_at DESC, id DESC);
CREATE INDEX restriction_episodes_source_report_idx
  ON moderation.restriction_episodes (source_report_id, started_at, id);

CREATE FUNCTION moderation.guard_restriction_episode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.target_user_id <> OLD.target_user_id
    OR NEW.source_report_id <> OLD.source_report_id
    OR NEW.distinct_reporter_count <> OLD.distinct_reporter_count
    OR NEW.started_at <> OLD.started_at OR OLD.status <> 'active' OR NEW.status <> 'resolved'
    OR NEW.resolved_at IS NULL OR NEW.resolved_by_admin_id IS NULL
    OR NEW.resolution_reason_code IS NULL OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'restriction episode transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER restriction_episodes_guard
BEFORE UPDATE ON moderation.restriction_episodes
FOR EACH ROW EXECUTE FUNCTION moderation.guard_restriction_episode();

CREATE FUNCTION moderation.reject_restriction_episode_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'restriction episodes are retained safety history' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER restriction_episodes_delete_guard
BEFORE DELETE ON moderation.restriction_episodes
FOR EACH ROW EXECUTE FUNCTION moderation.reject_restriction_episode_delete();

CREATE TABLE moderation.moderation_reviews (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL UNIQUE REFERENCES moderation.reports(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','in_review','dismissed','actioned'
  )),
  assigned_admin_id uuid REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  assigned_at timestamptz,
  decided_at timestamptz,
  decision_note_ciphertext bytea CHECK (
    decision_note_ciphertext IS NULL OR octet_length(decision_note_ciphertext) BETWEEN 17 AND 8192
  ),
  decision_note_key_id text CHECK (
    decision_note_key_id IS NULL OR char_length(decision_note_key_id) BETWEEN 8 AND 160
  ),
  decision_note_key_version integer CHECK (
    decision_note_key_version IS NULL OR decision_note_key_version >= 1
  ),
  decision_note_nonce bytea CHECK (
    decision_note_nonce IS NULL OR octet_length(decision_note_nonce) = 12
  ),
  decision_note_sha256 text CHECK (
    decision_note_sha256 IS NULL OR decision_note_sha256 ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT moderation_review_assignment_ck CHECK (
    (status = 'pending' AND assigned_admin_id IS NULL AND assigned_at IS NULL
      AND decided_at IS NULL)
    OR (status = 'in_review' AND assigned_admin_id IS NOT NULL AND assigned_at IS NOT NULL
      AND decided_at IS NULL)
    OR (status IN ('dismissed','actioned') AND assigned_admin_id IS NOT NULL
      AND assigned_at IS NOT NULL AND decided_at IS NOT NULL
      AND decided_at >= assigned_at)
  ),
  CONSTRAINT moderation_review_note_envelope_ck CHECK (
    (decision_note_ciphertext IS NULL AND decision_note_key_id IS NULL
      AND decision_note_key_version IS NULL AND decision_note_nonce IS NULL
      AND decision_note_sha256 IS NULL)
    OR (decision_note_ciphertext IS NOT NULL AND decision_note_key_id IS NOT NULL
      AND decision_note_key_version IS NOT NULL AND decision_note_nonce IS NOT NULL
      AND decision_note_sha256 IS NOT NULL)
  ),
  CONSTRAINT moderation_review_pending_note_ck CHECK (
    status IN ('dismissed','actioned') OR decision_note_ciphertext IS NULL
  )
);

CREATE INDEX moderation_reviews_queue_idx
  ON moderation.moderation_reviews (status, created_at, id)
  WHERE status IN ('pending','in_review');
CREATE INDEX moderation_reviews_assignee_idx
  ON moderation.moderation_reviews (assigned_admin_id, status, assigned_at, id)
  WHERE assigned_admin_id IS NOT NULL AND status = 'in_review';

CREATE FUNCTION moderation.guard_moderation_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.report_id <> OLD.report_id OR NEW.created_at <> OLD.created_at
    OR NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at
    OR NOT (
      (OLD.status = 'pending' AND NEW.status = 'in_review'
        AND OLD.assigned_admin_id IS NULL AND NEW.assigned_admin_id IS NOT NULL)
      OR (OLD.status = 'in_review' AND NEW.status IN ('dismissed','actioned')
        AND NEW.assigned_admin_id = OLD.assigned_admin_id)
      OR (OLD.status = 'in_review' AND NEW.status = 'in_review'
        AND NEW.assigned_admin_id <> OLD.assigned_admin_id)
    ) THEN
    RAISE EXCEPTION 'moderation review transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER moderation_reviews_guard
BEFORE UPDATE ON moderation.moderation_reviews
FOR EACH ROW EXECUTE FUNCTION moderation.guard_moderation_review();

CREATE FUNCTION moderation.reject_moderation_review_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'moderation reviews are retained safety history' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER moderation_reviews_delete_guard
BEFORE DELETE ON moderation.moderation_reviews
FOR EACH ROW EXECUTE FUNCTION moderation.reject_moderation_review_delete();

CREATE FUNCTION moderation.verify_review_report_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review_status text;
  report_status text;
  governed_report_id uuid;
BEGIN
  governed_report_id := CASE WHEN TG_TABLE_NAME = 'reports' THEN NEW.id ELSE NEW.report_id END;
  SELECT status INTO review_status FROM moderation.moderation_reviews
    WHERE report_id = governed_report_id;
  SELECT status INTO report_status FROM moderation.reports WHERE id = governed_report_id;
  IF review_status IS NOT NULL AND NOT (
    (review_status = 'pending' AND report_status = 'pending_review')
    OR (review_status = 'in_review' AND report_status = 'pending_review')
    OR (review_status = 'dismissed' AND report_status = 'dismissed')
    OR (review_status = 'actioned' AND report_status = 'actioned')
  ) THEN
    RAISE EXCEPTION 'review and report states disagree' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER moderation_review_report_consistent
AFTER INSERT OR UPDATE ON moderation.moderation_reviews
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION moderation.verify_review_report_state();
CREATE CONSTRAINT TRIGGER report_moderation_review_consistent
AFTER UPDATE ON moderation.reports
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION moderation.verify_review_report_state();

CREATE TABLE moderation.moderation_actions (
  id uuid PRIMARY KEY,
  action_type text NOT NULL CHECK (action_type IN (
    'restrict_user','unrestrict_user','ban_user','unban_user',
    'hide_photo','restore_photo','delete_photo',
    'create_internal_block','remove_internal_block'
  )),
  actor_type text NOT NULL CHECK (actor_type IN ('admin','system')),
  actor_admin_id uuid REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  target_user_id uuid REFERENCES identity.users(id) ON DELETE RESTRICT,
  target_photo_id uuid REFERENCES media.profile_photos(id) ON DELETE RESTRICT,
  target_pair_low_user_id uuid REFERENCES identity.users(id) ON DELETE RESTRICT,
  target_pair_high_user_id uuid REFERENCES identity.users(id) ON DELETE RESTRICT,
  source_report_id uuid REFERENCES moderation.reports(id) ON DELETE RESTRICT,
  restriction_episode_id uuid REFERENCES moderation.restriction_episodes(id) ON DELETE RESTRICT,
  audit_log_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
  notification_id uuid REFERENCES notification.notifications(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT moderation_action_actor_ck CHECK (
    (actor_type = 'system' AND actor_admin_id IS NULL AND action_type = 'restrict_user'
      AND restriction_episode_id IS NOT NULL AND source_report_id IS NOT NULL)
    OR (actor_type = 'admin' AND actor_admin_id IS NOT NULL)
  ),
  CONSTRAINT moderation_action_target_ck CHECK (
    (action_type IN ('restrict_user','unrestrict_user','ban_user','unban_user')
      AND target_user_id IS NOT NULL AND target_photo_id IS NULL
      AND target_pair_low_user_id IS NULL AND target_pair_high_user_id IS NULL)
    OR (action_type IN ('hide_photo','restore_photo','delete_photo')
      AND target_user_id IS NULL AND target_photo_id IS NOT NULL
      AND target_pair_low_user_id IS NULL AND target_pair_high_user_id IS NULL)
    OR (action_type IN ('create_internal_block','remove_internal_block')
      AND target_user_id IS NULL AND target_photo_id IS NULL
      AND target_pair_low_user_id IS NOT NULL AND target_pair_high_user_id IS NOT NULL
      AND target_pair_low_user_id < target_pair_high_user_id)
  )
);

CREATE UNIQUE INDEX moderation_actions_threshold_episode_uq
  ON moderation.moderation_actions (restriction_episode_id)
  WHERE actor_type = 'system' AND action_type = 'restrict_user';
CREATE INDEX moderation_actions_target_user_time_idx
  ON moderation.moderation_actions (target_user_id, occurred_at DESC, id DESC)
  WHERE target_user_id IS NOT NULL;
CREATE INDEX moderation_actions_report_time_idx
  ON moderation.moderation_actions (source_report_id, occurred_at DESC, id DESC)
  WHERE source_report_id IS NOT NULL;

CREATE FUNCTION moderation.reject_moderation_action_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'moderation actions are append-only' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER moderation_actions_immutable
BEFORE UPDATE OR DELETE ON moderation.moderation_actions
FOR EACH ROW EXECUTE FUNCTION moderation.reject_moderation_action_mutation();

CREATE FUNCTION moderation.verify_threshold_episode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  active_reporters integer;
BEGIN
  SELECT count(DISTINCT reporter_user_id) INTO active_reporters
  FROM moderation.reports
  WHERE target_user_id = NEW.target_user_id
    AND status IN ('submitted','pending_review')
    AND submitted_at > NEW.started_at - interval '30 days'
    AND submitted_at <= NEW.started_at;
  IF active_reporters < 5 OR NEW.distinct_reporter_count <> active_reporters
    OR NOT EXISTS (
      SELECT 1 FROM moderation.reports
      WHERE id = NEW.source_report_id AND target_user_id = NEW.target_user_id
        AND status = 'pending_review' AND priority = 'threshold'
    ) THEN
    RAISE EXCEPTION 'restriction episode does not match the threshold reports'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER restriction_episode_threshold_valid
BEFORE INSERT ON moderation.restriction_episodes
FOR EACH ROW EXECUTE FUNCTION moderation.verify_threshold_episode();

COMMENT ON TABLE moderation.restriction_episodes IS
  'One active five-distinct-reporter restriction episode per target; never an automatic ban.';
COMMENT ON TABLE moderation.moderation_reviews IS
  'Explicit single-report review workflow with encrypted optional decision notes.';
COMMENT ON TABLE moderation.moderation_actions IS
  'Append-only exact moderation effects; system actors may only create threshold restrictions.';
