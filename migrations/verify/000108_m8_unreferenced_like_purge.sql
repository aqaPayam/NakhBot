DO $$ BEGIN
  IF to_regprocedure('interaction.purge_deletion_unreferenced_likes(uuid,uuid,uuid,integer)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass
      AND tgname='account_deletion_product_batch_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR (SELECT count(*) FROM pg_constraint WHERE confrelid IN ('interaction.likes'::regclass,'interaction.like_reference_anchors'::regclass) AND contype='f'
      AND conrelid IN ('matching.matches'::regclass,'interaction.feature_unlocks'::regclass))<>3 THEN
    RAISE EXCEPTION 'unreferenced Like purge or retained source fence missing';
  END IF;
END $$;
