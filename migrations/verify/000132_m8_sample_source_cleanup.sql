DO $$ BEGIN
 IF to_regclass('platform.sample_reference_anchors') IS NULL
  OR to_regclass('identity.account_deletion_sample_receipts') IS NULL
  OR to_regprocedure('platform.sample_purge_proven(uuid,uuid)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.sample_effects'::regclass
    AND tgname='sample_reference_capture' AND tgenabled='O')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.sample_projections'::regclass
    AND tgname='sample_projection_write_fence' AND tgenabled='O') THEN
  RAISE EXCEPTION 'sample cleanup ownership or write fence missing';
 END IF;
END $$;
