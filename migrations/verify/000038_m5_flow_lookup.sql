DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'nakh'
      AND indexname = 'nakh_flows_direction_lookup_idx'
      AND indexdef LIKE '%(sender_user_id, receiver_user_id) INCLUDE (id)%'
  ) THEN
    RAISE EXCEPTION 'M5 covering directional flow lookup index is missing';
  END IF;
END $$;
