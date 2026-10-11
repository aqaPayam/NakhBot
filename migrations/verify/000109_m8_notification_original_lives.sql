DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM notification.notifications WHERE product_epoch<0)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='notification.notifications'::regclass
      AND tgname='notification_product_life_guard' AND tgenabled='O')
    OR to_regclass('interaction.current_like_lives') IS NULL OR to_regclass('matching.current_match_lives') IS NULL THEN
    RAISE EXCEPTION 'notification original-life authority missing';
  END IF;
END $$;
