DO $$ BEGIN
 IF to_regclass('media.asset_reference_anchors') IS NULL
  OR to_regclass('media.variant_reference_anchors') IS NULL
  OR to_regclass('identity.account_deletion_media_operations') IS NULL
  OR to_regclass('identity.account_deletion_media_receipts') IS NULL
  OR to_regclass('media.report_photo_source_facts') IS NULL THEN
  RAISE EXCEPTION 'media deletion sources or provider proof missing';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_media_receipts'::regclass
   AND tgname='deletion_media_receipt_required' AND tgdeferrable AND tginitdeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='media.report_photo_evidence_holds'::regclass
   AND confrelid='media.variant_reference_anchors'::regclass AND contype='f') THEN
  RAISE EXCEPTION 'media removal commit proof or retained evidence reference missing';
 END IF;
END $$;
