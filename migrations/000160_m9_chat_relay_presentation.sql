WITH seed(text_key,body) AS (VALUES ('chat.relay.open','Open chat'),('chat.relay.resume','Open /start, then Chats, to continue this conversation.'),('chat.relay.reply','Reply to this message or open the chat.'))
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,'message','[]'::jsonb,true,clock_timestamp(),clock_timestamp() FROM seed;
