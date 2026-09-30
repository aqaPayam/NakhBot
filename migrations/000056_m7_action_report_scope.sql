-- Validate new report-linked admin effects without rewriting immutable history.
CREATE FUNCTION moderation.verify_action_report_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_user uuid;
BEGIN
  IF NEW.actor_type <> 'admin' OR NEW.source_report_id IS NULL OR NEW.action_type = 'dismiss_report' THEN
    RETURN NEW;
  END IF;
  IF NEW.action_type IN ('restrict_user','unrestrict_user','ban_user','unban_user') THEN
    target_user := NEW.target_user_id;
  ELSIF NEW.action_type IN ('hide_photo','restore_photo','delete_photo') THEN
    SELECT profile.user_id INTO target_user FROM media.profile_photos photo
      JOIN profile.profiles profile ON profile.id = photo.profile_id WHERE photo.id = NEW.target_photo_id;
  ELSE
    RAISE EXCEPTION 'action does not support a report context' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM moderation.reports report
    JOIN moderation.moderation_reviews review ON review.report_id = report.id
    WHERE report.id = NEW.source_report_id AND report.target_user_id = target_user
      AND report.status = 'pending_review' AND review.status = 'in_review'
      AND review.assigned_admin_id = NEW.actor_admin_id
  ) THEN
    RAISE EXCEPTION 'action does not match its assigned report' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER moderation_action_report_scope_guard BEFORE INSERT ON moderation.moderation_actions
FOR EACH ROW EXECUTE FUNCTION moderation.verify_action_report_scope();

CREATE FUNCTION moderation.verify_action_report_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_target uuid;
  expected_type text;
  expected_command text;
BEGIN
  IF NEW.actor_type <> 'admin' OR NEW.source_report_id IS NULL THEN RETURN NULL; END IF;
  IF NEW.action_type = 'dismiss_report' THEN
    expected_type := 'moderation_review';
    expected_command := 'moderation.decide-review';
    SELECT id INTO expected_target FROM moderation.moderation_reviews WHERE report_id = NEW.source_report_id;
  ELSIF NEW.action_type IN ('hide_photo','restore_photo','delete_photo') THEN
    expected_target := NEW.target_photo_id;
    expected_type := 'photo';
    expected_command := 'moderation.apply-photo-action';
  ELSE
    expected_target := NEW.target_user_id;
    expected_type := 'user';
    expected_command := 'moderation.apply-account-action';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM administration.admin_action_logs log
    WHERE log.admin_user_id = NEW.actor_admin_id AND log.command_id = NEW.command_id
      AND log.request_id = NEW.request_id AND log.request_digest = NEW.request_digest
      AND log.command_code = expected_command AND log.target_type = expected_type
      AND log.target_id = expected_target AND log.result = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'report action lacks its successful admin attempt' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER moderation_action_report_attempt_guard AFTER INSERT ON moderation.moderation_actions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION moderation.verify_action_report_attempt();
