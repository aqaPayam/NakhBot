DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='channel_telegram' AND table_name='liked_by_delivery_requests'
      AND column_name='product_epoch' AND data_type='integer' AND is_nullable='NO')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger
      WHERE tgrelid='channel_telegram.liked_by_delivery_requests'::regclass
        AND tgname='liked_by_request_life_guard' AND tgenabled='O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'original Liked By request life fence missing';
  END IF;
END $$;
