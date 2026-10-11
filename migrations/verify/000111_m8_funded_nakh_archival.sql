DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_nakh_receipts'::regclass
      AND tgname='nakh_archival_receipt_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_nakh_receipts'::regclass
      AND tgname='nakh_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakhes'::regclass
      AND tgname='nakhes_archival_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakh_status_history'::regclass
      AND tgname='nakh_status_history_archival_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='identity' AND indexname='deletion_nakh_receipts_final_idx')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakhes'::regclass
      AND tgname='a_nakh_archived_funding_guard' AND tgenabled='O')
    OR position('pg_current_xact_id' in pg_get_functiondef('nakh.authorize_deletion_batch(uuid,boolean)'::regprocedure))=0
    OR position('LIMIT 100' in pg_get_functiondef('nakh.purge_deletion_funded_source(uuid,uuid,uuid,integer)'::regprocedure))=0
    OR position('original_funded_scope_valid' in pg_get_functiondef('identity.guard_nakh_archival_receipt()'::regprocedure))=0
    OR position('account_deletion_nakh_receipts' in pg_get_viewdef('nakh.nakh_lifecycle_facts'::regclass))=0 THEN
    RAISE EXCEPTION 'bounded original funded Nakh archival safeguards missing';
  END IF;
END $$;
