-- Extend the action catalog without rewriting applied migrations or prior safety history.
ALTER TABLE moderation.moderation_actions DROP CONSTRAINT moderation_actions_action_type_check;
ALTER TABLE moderation.moderation_actions ADD CONSTRAINT moderation_actions_action_type_check
CHECK (action_type IN ('restrict_user','unrestrict_user','ban_user','unban_user',
  'hide_photo','restore_photo','delete_photo','create_internal_block','remove_internal_block','dismiss_report'));

ALTER TABLE moderation.moderation_actions DROP CONSTRAINT moderation_action_target_ck;
ALTER TABLE moderation.moderation_actions ADD CONSTRAINT moderation_action_target_ck CHECK (
  (action_type IN ('restrict_user','unrestrict_user','ban_user','unban_user','dismiss_report')
    AND target_user_id IS NOT NULL AND target_photo_id IS NULL
    AND target_pair_low_user_id IS NULL AND target_pair_high_user_id IS NULL)
  OR (action_type IN ('hide_photo','restore_photo','delete_photo')
    AND target_user_id IS NULL AND target_photo_id IS NOT NULL
    AND target_pair_low_user_id IS NULL AND target_pair_high_user_id IS NULL)
  OR (action_type IN ('create_internal_block','remove_internal_block')
    AND target_user_id IS NULL AND target_photo_id IS NULL
    AND target_pair_low_user_id IS NOT NULL AND target_pair_high_user_id IS NOT NULL
    AND target_pair_low_user_id < target_pair_high_user_id)
);
ALTER TABLE moderation.moderation_actions ADD CONSTRAINT moderation_dismissal_shape_ck CHECK (
  action_type <> 'dismiss_report' OR (actor_type = 'admin' AND source_report_id IS NOT NULL
    AND restriction_episode_id IS NULL AND notification_id IS NULL)
);
CREATE FUNCTION moderation.verify_dismissal_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_type = 'dismiss_report' AND NOT EXISTS (
    SELECT 1 FROM moderation.reports report
    JOIN moderation.moderation_reviews review ON review.report_id = report.id
    WHERE report.id = NEW.source_report_id AND report.target_user_id = NEW.target_user_id
      AND report.status = 'dismissed' AND review.status = 'dismissed'
      AND review.assigned_admin_id = NEW.actor_admin_id
  ) THEN
    RAISE EXCEPTION 'dismissal action does not match a terminal review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER moderation_dismissal_action_guard BEFORE INSERT ON moderation.moderation_actions
FOR EACH ROW EXECUTE FUNCTION moderation.verify_dismissal_action();
