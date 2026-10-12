DO $$ BEGIN
  IF to_regclass('identity.account_deletion_terminal_pending_receipts') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_terminal_pending_receipts'::regclass
      AND tgname='terminal_pending_archival_receipt_guard' AND tgenabled='O' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_terminal_pending_receipts'::regclass
      AND tgname='terminal_pending_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR to_regprocedure('nakh.purge_deletion_terminal_pending_source(uuid,uuid,uuid,integer)') IS NULL
    OR position('pending_nakh_lifecycle_facts' IN pg_get_functiondef(
      'billing.pending_nakh_has_bound_closure(uuid)'::regprocedure))=0
    OR position('pending_nakh_lifecycle_facts' IN pg_get_functiondef(
      'identity.deletion_has_unresolved_shared_payments(uuid)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'terminal pending archival proof or native guard missing';
  END IF;
END $$;
