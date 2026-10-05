DO $$
BEGIN
  IF to_regclass('moderation.threshold_admission_witnesses') IS NULL OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'moderation'
      AND table_name = 'restriction_episodes' AND column_name = 'witness_required'
      AND is_nullable = 'NO' AND column_default = 'true'
  ) OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'moderation.threshold_admission_witnesses'::regclass
    AND convalidated AND contype IN ('p','u','f')) <> 5 THEN
    RAISE EXCEPTION 'threshold admission witness schema is incomplete';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'moderation.threshold_admission_witnesses'::regclass
    AND NOT tgisinternal AND tgenabled = 'O' AND tgname = 'threshold_admission_witness_guard') <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'moderation.restriction_episodes'::regclass
      AND tgname = 'threshold_admission_witness_cardinality' AND tgdeferrable AND tginitdeferred)
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'moderation.restriction_episodes'::regclass
      AND NOT tgisinternal AND tgenabled = 'O' AND tgname IN
        ('restriction_episode_witness_mode','restriction_episode_capture_witnesses')) <> 2 THEN
    RAISE EXCEPTION 'threshold admission witness guards are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'moderation.restriction_episodes'::regclass
    AND conname = 'restriction_episode_witness_mode_ck' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'moderation'
      AND table_name = 'restriction_episodes' AND column_name = 'witness_capture_xid'
      AND udt_name = 'xid8' AND column_default = 'pg_current_xact_id()') THEN
    RAISE EXCEPTION 'threshold admission capture transaction binding is incomplete';
  END IF;
END $$;
