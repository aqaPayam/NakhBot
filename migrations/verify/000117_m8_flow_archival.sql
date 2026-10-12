DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_flow_receipts'::regclass
    AND tgname='flow_archival_receipt_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_flow_receipts'::regclass
      AND tgname='flow_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR EXISTS(SELECT 1 FROM identity.account_deletion_flow_receipts receipt WHERE NOT identity.flow_receipt_proof_valid(receipt)
      OR EXISTS(SELECT 1 FROM nakh.nakh_flows WHERE id=receipt.flow_id)
      OR nakh.flow_source_archivable(receipt.flow_id) IS NOT TRUE) THEN
    RAISE EXCEPTION 'Flow archival proof or guards incomplete';
  END IF;
END $$;
