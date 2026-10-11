DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.pending_nakh_reference_anchors'::regclass
      AND tgname='pending_nakh_reference_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.pending_nakh_reference_anchors'::regclass
      AND tgname='pending_nakh_reference_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.pending_nakhes'::regclass
      AND tgname='pending_nakh_original_reference_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.pending_nakhes'::regclass
      AND tgname='pending_nakh_original_reference' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.pending_nakhes'::regclass
      AND tgname='a_pending_nakh_original_identity_guard' AND tgenabled='O')
    OR EXISTS(SELECT 1 FROM nakh.pending_nakhes pending WHERE NOT nakh.original_pending_reference_valid(pending.id)) THEN
    RAISE EXCEPTION 'original pending Nakh reference safeguards missing';
  END IF;
END $$;
