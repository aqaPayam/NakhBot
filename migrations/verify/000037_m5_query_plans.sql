DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_statistic_ext statistics
    JOIN pg_namespace namespace ON namespace.oid = statistics.stxnamespace
    WHERE namespace.nspname = 'nakh'
      AND statistics.stxname = 'nakh_flows_direction_stats'
      AND statistics.stxkind @> ARRAY['d'::"char", 'f'::"char"]
  ) THEN
    RAISE EXCEPTION 'M5 directional flow planner statistics are missing';
  END IF;
END $$;
