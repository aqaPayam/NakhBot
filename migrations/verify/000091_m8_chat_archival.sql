DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM chat.chat_sessions source LEFT JOIN chat.chat_reference_anchors anchor ON anchor.id=source.id
    WHERE anchor.match_id IS DISTINCT FROM source.match_id)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='chat.chat_sessions'::regclass AND tgname='chat_archival_delete_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='chat.chat_messages'::regclass AND tgname='deleted_message_archival_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='chat.chat_reference_anchors'::regclass AND tgname='chat_reference_anchor_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_chat_receipts'::regclass
      AND tgname='chat_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='moderation.report_evidence'::regclass
      AND conname='report_evidence_chat_session_id_fkey' AND confrelid='chat.chat_reference_anchors'::regclass)
    OR position('account_deletion_chat_receipts' in pg_get_functiondef('matching.verify_unmatch_consistency()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'chat source archival safeguards missing';
  END IF;
END $$;
