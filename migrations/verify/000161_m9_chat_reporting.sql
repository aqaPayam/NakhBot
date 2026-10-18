DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND category='message'
  AND ((text_key='chat.report.message' AND variables='["number"]'::jsonb)
   OR (text_key IN ('chat.report.conversation','chat.report.ended','chat.report.ended_empty') AND variables='[]'::jsonb)))<>4
 THEN RAISE EXCEPTION 'Chat report presentation incomplete'; END IF;
END $$;
DO $$ BEGIN
 IF platform.deletion_event_disposition('moderation.report-submitted.v1',1,
  '{"reportId":"10000000-0000-4000-8000-000000000001","evidenceTypes":["message","unmatched_user"],"status":"pending_review"}'::jsonb)<>'safety_proof'
  OR platform.deletion_event_disposition('moderation.report-submitted.v1',1,
  '{"reportId":"10000000-0000-4000-8000-000000000001","evidenceTypes":["unknown"],"status":"pending_review"}'::jsonb)<>'unclassified'
 THEN RAISE EXCEPTION 'Report publication classification invalid'; END IF;
END $$;
