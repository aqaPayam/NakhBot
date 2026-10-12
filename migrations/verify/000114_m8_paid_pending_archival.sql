DO $$ BEGIN
  IF to_regclass('identity.account_deletion_paid_pending_receipts') IS NULL
    OR to_regclass('nakh.pending_nakh_lifecycle_facts') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_paid_pending_receipts'::regclass
      AND tgname='paid_pending_archival_receipt_guard' AND tgenabled='O' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_paid_pending_receipts'::regclass
      AND tgname='paid_pending_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.pending_nakhes'::regclass
      AND tgname='pending_nakhes_paid_archival_guard' AND tgenabled='O' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.telegram_stars_receipts'::regclass
      AND tgname='pending_capture_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.payment_fulfillments'::regclass
      AND tgname='pending_capture_fulfillment_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR position('pending_nakh_lifecycle_facts' IN pg_get_functiondef(
      'nakh.original_pending_reference_valid(uuid)'::regprocedure))=0
    OR position('pending_nakh_lifecycle_facts' IN pg_get_functiondef(
      'nakh.original_funded_scope_valid(uuid,uuid,uuid,uuid,text,uuid,uuid)'::regprocedure))=0
    OR position('pending_nakh_lifecycle_facts' IN pg_get_functiondef(
      'nakh.verify_pending_nakh_payment()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'paid pending archival proof or native guard missing';
  END IF;
END $$;
