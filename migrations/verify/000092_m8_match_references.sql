DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM matching.matches source LEFT JOIN matching.match_reference_anchors anchor ON anchor.id=source.id
    WHERE anchor.user_low_id IS DISTINCT FROM source.user_low_id OR anchor.user_high_id IS DISTINCT FROM source.user_high_id)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='matching.match_reference_anchors'::regclass
      AND tgname='match_reference_anchor_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='matching.matches'::regclass
      AND tgname='match_reference_anchor_required' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='matching.matches'::regclass
      AND tgname='match_archival_delete_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='matching.matches'::regclass
      AND tgname='match_reference_anchor_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='matching.unmatch_records'::regclass
      AND conname='unmatch_records_match_id_fkey' AND confrelid='matching.match_reference_anchors'::regclass AND confdeltype='r')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='chat.chat_reference_anchors'::regclass
      AND conname='chat_reference_anchors_match_id_fkey' AND confrelid='matching.match_reference_anchors'::regclass AND confdeltype='r') THEN
    RAISE EXCEPTION 'match reference safeguards missing';
  END IF;
END $$;
