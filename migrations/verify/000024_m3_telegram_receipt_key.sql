DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'channel_telegram.liked_by_delivery_receipts'::regclass
      AND conname = 'liked_by_delivery_receipt_key_ck'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'M3 Telegram opaque receipt-key constraint is missing';
  END IF;
END $$;
