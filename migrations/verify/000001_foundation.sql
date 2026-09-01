DO $$
BEGIN
  IF to_regclass('platform.idempotency_records') IS NULL
    OR to_regclass('platform.outbox_events') IS NULL
    OR to_regclass('platform.inbox_messages') IS NULL
    OR to_regclass('platform.sample_effects') IS NULL
    OR to_regclass('platform.sample_projections') IS NULL THEN
    RAISE EXCEPTION 'foundation tables are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'platform' AND indexname = 'outbox_dispatch_idx'
  ) THEN
    RAISE EXCEPTION 'outbox dispatch index is missing';
  END IF;
END
$$;
