DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_match_receipts'::regclass
      AND tgname='match_archival_receipt_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_match_receipts'::regclass
      AND tgname='match_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_match_receipts'::regclass
      AND tgname='match_archival_unmatch_consistent' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_match_receipts'::regclass
      AND tgname='match_archival_nakh_consistent' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.feature_unlocks'::regclass
      AND tgname='feature_unlock_live_match_required' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='interaction.feature_unlocks'::regclass
      AND conname='feature_unlocks_match_id_fkey' AND confrelid='matching.match_reference_anchors'::regclass AND confdeltype='r')
    OR position('account_deletion_match_receipts' in pg_get_viewdef('matching.match_lifecycle_facts'::regclass))=0
    OR position('match_lifecycle_facts' in pg_get_functiondef('matching.verify_unmatch_consistency()'::regprocedure))=0
    OR position('match_lifecycle_facts' in pg_get_functiondef('nakh.verify_nakh_match()'::regprocedure))=0
    OR position('match_lifecycle_facts' in pg_get_functiondef('moderation.validate_report_evidence()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'match source archival safeguards missing';
  END IF;
END $$;
