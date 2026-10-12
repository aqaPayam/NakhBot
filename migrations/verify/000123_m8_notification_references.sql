DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='notification.notice_reference_anchors'::regclass AND tgname='notice_reference_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='moderation.moderation_actions'::regclass
      AND tgname='action_notice_reference_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='moderation.moderation_actions'::regclass
      AND conname='moderation_actions_notification_id_fkey' AND confrelid='notification.notice_reference_anchors'::regclass
      AND condeferrable AND condeferred) THEN
    RAISE EXCEPTION 'original notice reference guards incomplete'; END IF;
END $$;
