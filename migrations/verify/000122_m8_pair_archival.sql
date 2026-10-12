DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.user_pair_states'::regclass AND tgname='pair_archival_delete_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_pair_receipts'::regclass
      AND tgname='pair_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR position('pair_receipt_proof_valid' in pg_get_functiondef('matching.verify_unmatch_consistency()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'ordinary pair archival guards incomplete'; END IF;
END $$;
