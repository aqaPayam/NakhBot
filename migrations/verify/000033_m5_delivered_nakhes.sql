DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'nakh' AND table_name = 'nakhes')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'nakh' AND table_name = 'nakh_status_history')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'nakh' AND table_name = 'nakh_receiver_actions') THEN
    RAISE EXCEPTION 'M5 delivered Nakh tables are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'nakh' AND indexname = 'nakhes_receiver_inbox_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'nakh' AND indexname = 'nakhes_sender_status_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'nakh' AND indexname = 'nakhes_expiry_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'nakh' AND indexname = 'nakh_receiver_actions_terminal_idx') THEN
    RAISE EXCEPTION 'M5 delivered Nakh indexes are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nakhes_lifecycle_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nakh_status_history_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nakh_receiver_actions_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nakhes_history_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nakh_status_history_aggregate_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M5 delivered Nakh lifecycle guards are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nakh_flow_identity_fk' AND contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nakh_receiver_action_owner_fk' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'M5 delivered Nakh ownership constraints are incomplete';
  END IF;
END $$;
