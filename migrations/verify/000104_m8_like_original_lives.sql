DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM interaction.likes source
      WHERE source.sender_product_epoch IS NULL OR source.receiver_product_epoch IS NULL)
    OR EXISTS(SELECT 1 FROM interaction.likes source LEFT JOIN interaction.like_reference_anchors anchor ON anchor.id=source.id
      WHERE (EXISTS(SELECT 1 FROM matching.matches original WHERE source.id IN (original.source_like_a_id,original.source_like_b_id))
        OR EXISTS(SELECT 1 FROM interaction.feature_unlocks original WHERE original.like_id=source.id))
      AND (anchor.sender_user_id IS DISTINCT FROM source.sender_user_id OR anchor.receiver_user_id IS DISTINCT FROM source.receiver_user_id
        OR anchor.sender_product_epoch IS DISTINCT FROM source.sender_product_epoch OR anchor.receiver_product_epoch IS DISTINCT FROM source.receiver_product_epoch))
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.likes'::regclass AND tgname='likes_original_lives_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.like_reference_anchors'::regclass AND tgname='like_reference_anchor_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.like_reference_anchors'::regclass AND tgname='like_reference_anchor_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='matching.matches'::regclass AND tgname='match_original_like_references' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.feature_unlocks'::regclass AND tgname='unlock_original_like_reference' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='matching.matches'::regclass AND tgname='match_original_like_references_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.feature_unlocks'::regclass AND tgname='unlock_original_like_reference_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR (SELECT count(*) FROM pg_constraint WHERE confrelid='interaction.likes'::regclass AND contype='f'
      AND conrelid IN ('matching.matches'::regclass,'interaction.feature_unlocks'::regclass) AND confdeltype='r')<>3 THEN
    RAISE EXCEPTION 'original Like ownership/reference safeguards missing';
  END IF;
END $$;
