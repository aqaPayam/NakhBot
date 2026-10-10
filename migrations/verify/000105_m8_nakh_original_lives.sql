DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM nakh.nakh_flows WHERE sender_product_epoch IS NULL OR receiver_product_epoch IS NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakh_flows'::regclass AND tgname='nakh_flow_original_lives_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakh_flows'::regclass AND tgname='nakh_flows_immutable' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.pending_nakhes'::regclass AND tgname='pending_nakh_original_lives_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakhes'::regclass AND tgname='delivered_nakh_original_lives_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.pending_nakhes'::regclass AND tgname='pending_nakh_original_funding_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR EXISTS(SELECT 1 FROM nakh.current_flow_lives flow
      JOIN identity.accounts sender ON sender.user_id=flow.sender_user_id
      JOIN identity.accounts receiver ON receiver.user_id=flow.receiver_user_id
      WHERE sender.state='deleted' OR receiver.state='deleted'
        OR sender.product_epoch<>flow.sender_product_epoch OR receiver.product_epoch<>flow.receiver_product_epoch) THEN
    RAISE EXCEPTION 'original Nakh life safeguards missing';
  END IF;
END $$;
