DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='identity.account_deletion_phase_receipts'::regclass
      AND conname='deletion_phase_receipt_transition_check'
      AND position('media_objects' in pg_get_constraintdef(oid))>0)
    OR to_regprocedure('identity.finish_deletion_product_phase(uuid,uuid,uuid,integer,integer)') IS NULL
    OR to_regprocedure('identity.deletion_product_blocker(uuid,uuid)') IS NULL
    OR jsonb_array_length(identity.deletion_product_selectors())<27 THEN
    RAISE EXCEPTION 'whole-product checkpoint verification missing'; END IF;
END $$;
