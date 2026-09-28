DO $$
BEGIN
  IF to_regclass('moderation.appeal_submissions') IS NULL OR (
    SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
      'appeal_submissions_immutable', 'appeal_submissions_owner_guard',
      'user_appeals_ban_guard', 'user_appeals_delete_guard'
    )
  ) <> 4 THEN
    RAISE EXCEPTION 'appeal admission guards are incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM moderation.user_appeals a
    JOIN identity.account_state_history h ON h.id = a.ban_state_history_id
    WHERE h.user_id <> a.user_id OR h.next_state <> 'banned'
  ) THEN
    RAISE EXCEPTION 'appeal ban ownership mismatch';
  END IF;
END $$;
