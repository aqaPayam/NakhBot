DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.feature_unlock_reference_anchors'::regclass
    AND tgname='unlock_reference_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.feature_unlocks'::regclass
      AND tgname='feature_unlock_original_source_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.feature_unlocks'::regclass
      AND tgname='feature_unlock_original_reference_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR EXISTS(SELECT 1 FROM interaction.feature_unlocks original
      LEFT JOIN interaction.feature_unlock_reference_anchors anchor ON anchor.id=original.id
      WHERE anchor.id IS NULL OR interaction.unlock_reference_matches_source(anchor) IS NOT TRUE
        OR interaction.unlock_reference_financial_life_valid(anchor) IS NOT TRUE) THEN
    RAISE EXCEPTION 'original unlock references or immutable guards incomplete';
  END IF;
END $$;
