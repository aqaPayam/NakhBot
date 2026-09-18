DO $$ BEGIN
  IF to_regclass('channel_telegram.liked_by_delivery_requests') IS NULL THEN
    RAISE EXCEPTION 'M3 Telegram Liked By delivery requests are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'channel_telegram' AND indexname = 'liked_by_delivery_due_idx'
  ) THEN
    RAISE EXCEPTION 'M3 Telegram Liked By due index is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'channel_telegram.liked_by_delivery_requests'::regclass
      AND contype = 'u'
      AND conname = 'liked_by_delivery_requests_bot_id_update_id_key'
  ) THEN
    RAISE EXCEPTION 'M3 Telegram update deduplication is missing';
  END IF;
END $$;
