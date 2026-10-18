DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND text_key IN ('chat.list.title','chat.list.empty','chat.history.self','chat.history.peer','chat.history.older','chat.history.refresh','chat.button.back','chat.button.confirm','chat.button.cancel','chat.unmatch.confirm','chat.unlock.confirm','chat.message.sent') AND category='message' AND variables=CASE WHEN text_key='chat.unlock.confirm' THEN '["credits"]'::jsonb ELSE '[]'::jsonb END)<>12 THEN
  RAISE EXCEPTION 'Chat presentation catalog incomplete';
 END IF;
END $$;
