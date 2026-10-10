DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM nakh.nakhes source JOIN nakh.nakh_flows flow ON flow.id=source.nakh_flow_id
    LEFT JOIN nakh.nakh_reference_anchors anchor ON anchor.id=source.id
    WHERE anchor.nakh_flow_id IS DISTINCT FROM source.nakh_flow_id
      OR anchor.sender_user_id IS DISTINCT FROM source.sender_user_id OR anchor.receiver_user_id IS DISTINCT FROM source.receiver_user_id
      OR anchor.sender_product_epoch IS DISTINCT FROM flow.sender_product_epoch OR anchor.receiver_product_epoch IS DISTINCT FROM flow.receiver_product_epoch)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakh_reference_anchors'::regclass AND tgname='nakh_reference_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakh_reference_anchors'::regclass AND tgname='nakh_reference_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakhes'::regclass AND tgname='nakh_original_reference' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakhes'::regclass AND tgname='nakh_original_reference_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakhes'::regclass AND tgname='nakh_original_identity_guard' AND tgenabled='O') THEN
    RAISE EXCEPTION 'original Nakh reference safeguards missing';
  END IF;
END $$;
