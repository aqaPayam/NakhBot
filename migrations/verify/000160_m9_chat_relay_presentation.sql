DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND category='message' AND variables='[]'::jsonb AND text_key IN ('chat.relay.open','chat.relay.resume','chat.relay.reply'))<>3 THEN RAISE EXCEPTION 'Chat relay presentation incomplete'; END IF;
END $$;
