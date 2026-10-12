DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='matching' AND indexname='match_reference_original_pair_lives_uq')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='matching.matches'::regclass AND tgname='match_retired_identity_guard' AND tgenabled='O')
    OR EXISTS(SELECT 1 FROM matching.matches source LEFT JOIN matching.match_reference_anchors anchor ON anchor.id=source.id
      WHERE anchor.id IS NULL OR anchor.user_low_id<>source.user_low_id OR anchor.user_high_id<>source.user_high_id) THEN
    RAISE EXCEPTION 'Match original-life reference guards incomplete'; END IF;
END $$;
