DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='billing.credit_transactions'::regclass
      AND conname='credit_transactions_nakh_fk' AND confrelid='nakh.nakh_reference_anchors'::regclass
      AND convalidated AND condeferrable AND condeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='matching.matches'::regclass
      AND conname='matches_source_nakh_fk' AND confrelid='nakh.nakh_reference_anchors'::regclass
      AND convalidated AND condeferrable AND condeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_transactions'::regclass
      AND tgname='credit_original_nakh_reference' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='matching.matches'::regclass
      AND tgname='match_original_nakh_reference' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakhes'::regclass
      AND tgname='nakhes_lifecycle_guard' AND tgenabled='O') THEN
    RAISE EXCEPTION 'retained Nakh routing or live source safeguards missing';
  END IF;
END $$;
