DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM profile.profiles source LEFT JOIN profile.profile_reference_anchors anchor ON anchor.id=source.id
    WHERE anchor.user_id IS DISTINCT FROM source.user_id)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='profile.profiles'::regclass AND tgname='profile_archival_delete_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='profile.profile_reference_anchors'::regclass AND tgname='profile_reference_anchor_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_profile_receipts'::regclass
      AND tgname='profile_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'profile source archival safeguards missing';
  END IF;
END $$;
