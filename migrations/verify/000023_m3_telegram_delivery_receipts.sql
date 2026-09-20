DO $$ BEGIN
  IF to_regclass('channel_telegram.liked_by_delivery_receipts') IS NULL THEN
    RAISE EXCEPTION 'M3 Telegram Liked By delivery receipts are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'channel_telegram.liked_by_delivery_receipts'::regclass
      AND contype = 'p'
  ) THEN
    RAISE EXCEPTION 'M3 Telegram receipt logical-message uniqueness is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'channel_telegram.liked_by_delivery_receipts'::regclass
      AND contype = 'f'
      AND confrelid = 'channel_telegram.liked_by_delivery_requests'::regclass
      AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'M3 Telegram receipt retention cascade is missing';
  END IF;
END $$;
