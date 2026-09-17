DO $$ BEGIN
  IF to_regprocedure('interaction.lock_user_pair(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'M3 canonical pair-lock function is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'profile' AND indexname = 'profiles_complete_global_shuffle_idx'
  ) THEN
    RAISE EXCEPTION 'M3 global candidate shuffle index is missing';
  END IF;
END $$;
