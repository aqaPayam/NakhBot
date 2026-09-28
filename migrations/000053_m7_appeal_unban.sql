CREATE TABLE moderation.appeal_unbans (
  appeal_id uuid PRIMARY KEY REFERENCES moderation.user_appeals(id) ON DELETE RESTRICT,
  action_id uuid NOT NULL UNIQUE REFERENCES moderation.moderation_actions(id) ON DELETE RESTRICT,
  unban_history_id uuid NOT NULL UNIQUE REFERENCES identity.account_state_history(id) ON DELETE RESTRICT,
  admin_action_log_id uuid NOT NULL UNIQUE REFERENCES administration.admin_action_logs(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER appeal_unbans_immutable BEFORE UPDATE OR DELETE ON moderation.appeal_unbans
FOR EACH ROW EXECUTE FUNCTION support.reject_message_mutation();

-- The attempt log is inserted by the outer coordinator after the business effect savepoint.
CREATE FUNCTION moderation.validate_appeal_unban() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM moderation.user_appeals appeal
    JOIN moderation.moderation_actions action ON action.id = NEW.action_id
    JOIN identity.account_state_history history ON history.id = NEW.unban_history_id
    JOIN administration.admin_action_logs log ON log.id = NEW.admin_action_log_id
    WHERE appeal.id = NEW.appeal_id AND appeal.status = 'accepted'
      AND action.action_type = 'unban_user' AND action.target_user_id = appeal.user_id
      AND history.user_id = appeal.user_id AND history.previous_state = 'banned'
      AND history.next_state IN ('guest', 'incomplete', 'active', 'restricted')
      AND history.actor_type = 'admin' AND history.actor_admin_id = action.actor_admin_id
      AND log.result = 'succeeded' AND log.command_code = 'moderation.unban-appeal'
      AND log.target_type = 'user_appeal' AND log.target_id = appeal.id
      AND log.command_id = action.command_id AND log.admin_user_id = action.actor_admin_id
  ) THEN
    RAISE EXCEPTION 'appeal unban evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER appeal_unbans_consistent AFTER INSERT ON moderation.appeal_unbans
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION moderation.validate_appeal_unban();
