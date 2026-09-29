DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'moderation.moderation_actions'::regclass
      AND conname = 'moderation_dismissal_shape_ck' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'moderation.moderation_actions'::regclass
        AND tgname = 'moderation_dismissal_action_guard' AND tgenabled = 'O')
    OR position('dismiss_report' in pg_get_constraintdef((SELECT oid FROM pg_constraint
      WHERE conrelid = 'moderation.moderation_actions'::regclass AND conname = 'moderation_actions_action_type_check'))) = 0 THEN
    RAISE EXCEPTION 'review decision action guards are missing';
  END IF;
END $$;
