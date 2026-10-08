DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM media.profile_photos source LEFT JOIN media.photo_reference_anchors anchor ON anchor.id=source.id
    WHERE anchor.profile_id IS DISTINCT FROM source.profile_id OR anchor.asset_id IS DISTINCT FROM source.asset_id)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='media.photo_reference_anchors'::regclass AND tgname='photo_reference_anchor_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='media.profile_photos'::regclass AND tgname='photo_archival_delete_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='media.profile_photos'::regclass
      AND tgname='photo_reference_anchor_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_photo_receipts'::regclass
      AND tgname='photo_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR (SELECT count(*) FROM pg_constraint WHERE confrelid='media.photo_reference_anchors'::regclass
      AND conrelid IN ('media.photo_moderation_records'::regclass,'media.report_photo_evidence_holds'::regclass,
        'moderation.moderation_actions'::regclass,'moderation.report_evidence'::regclass) AND confdeltype='r')<>4
    OR position('photo_reference_anchors' in pg_get_functiondef('identity.profile_captures_verified(uuid,uuid)'::regprocedure))=0
    OR position('photo_reference_anchors' in pg_get_functiondef('media.validate_report_photo_hold_binding()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'photo source archival safeguards missing';
  END IF;
END $$;
