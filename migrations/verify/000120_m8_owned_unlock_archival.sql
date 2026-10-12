DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.feature_unlocks'::regclass
      AND tgname='owned_unlock_archival_delete_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_unlock_receipts'::regclass
      AND tgname='unlock_archival_receipt_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_unlock_receipts'::regclass
      AND tgname='unlock_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='billing.credit_transactions'::regclass
      AND conname='credit_transactions_feature_unlock_fk' AND confrelid='interaction.feature_unlock_reference_anchors'::regclass
      AND condeferrable AND condeferred AND confdeltype='r')
    OR EXISTS(SELECT 1 FROM identity.account_deletion_unlock_receipts receipt
      WHERE NOT identity.unlock_receipt_proof_valid(receipt)
        OR EXISTS(SELECT 1 FROM interaction.feature_unlocks WHERE id=receipt.unlock_id)
        OR interaction.unlock_source_archivable(receipt.unlock_id) IS NOT TRUE) THEN
    RAISE EXCEPTION 'owned unlock removal or historical proof incomplete';
  END IF;
END $$;
