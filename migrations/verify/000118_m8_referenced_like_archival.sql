DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_like_receipts'::regclass
    AND tgname='like_archival_receipt_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_like_receipts'::regclass
      AND tgname='like_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.likes'::regclass
      AND tgname='referenced_like_archival_delete_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='interaction.feature_unlocks'::regclass
      AND tgname='feature_unlock_live_like_required' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='interaction.feature_unlocks'::regclass
      AND conname='feature_unlocks_like_id_fkey' AND confrelid='interaction.like_reference_anchors'::regclass
      AND confdeltype='r' AND condeferrable AND condeferred)
    OR EXISTS(SELECT 1 FROM identity.account_deletion_like_receipts receipt
      WHERE NOT identity.like_receipt_proof_valid(receipt)
        OR EXISTS(SELECT 1 FROM interaction.likes WHERE id=receipt.like_id)
        OR interaction.like_source_archivable(receipt.like_id) IS NOT TRUE) THEN
    RAISE EXCEPTION 'referenced Like archival or live grant safeguards incomplete';
  END IF;
END $$;
