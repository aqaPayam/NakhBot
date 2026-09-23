DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'nakh'
      AND indexname = 'nakh_flows_direction_ordered_idx'
      AND indexdef LIKE '%(sender_user_id, receiver_user_id, id)%'
  ) THEN
    RAISE EXCEPTION 'M5 ordered directional flow lookup index is missing';
  END IF;
END $$;
