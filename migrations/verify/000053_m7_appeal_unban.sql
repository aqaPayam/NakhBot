DO $$
BEGIN
  IF to_regclass('moderation.appeal_unbans') IS NULL OR (
    SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN ('appeal_unbans_immutable', 'appeal_unbans_consistent')
  ) <> 2 THEN
    RAISE EXCEPTION 'appeal unban evidence guards are incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM moderation.appeal_unbans proof
    JOIN moderation.user_appeals appeal ON appeal.id = proof.appeal_id
    JOIN moderation.moderation_actions action ON action.id = proof.action_id
    JOIN identity.account_state_history history ON history.id = proof.unban_history_id
    JOIN administration.admin_action_logs log ON log.id = proof.admin_action_log_id
    WHERE appeal.status <> 'accepted' OR action.action_type <> 'unban_user'
      OR action.target_user_id <> appeal.user_id OR history.user_id <> appeal.user_id
      OR history.previous_state <> 'banned' OR history.next_state = 'banned'
      OR log.result <> 'succeeded' OR log.command_code <> 'moderation.unban-appeal'
      OR log.target_id <> appeal.id OR log.command_id <> action.command_id
  ) THEN
    RAISE EXCEPTION 'appeal unban evidence mismatch';
  END IF;
END $$;
