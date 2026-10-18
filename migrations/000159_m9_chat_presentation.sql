-- Chat presentation only; private bodies remain in their existing native stores.
WITH seed(text_key,body,variables) AS (VALUES
 ('chat.list.title','Chats','[]'::jsonb),
 ('chat.list.empty','No active chats.','[]'::jsonb),
 ('chat.history.self','You','[]'::jsonb),
 ('chat.history.peer','Match','[]'::jsonb),
 ('chat.history.older','Older messages','[]'::jsonb),
 ('chat.history.refresh','Refresh messages','[]'::jsonb),
 ('chat.button.back','Back','[]'::jsonb),
 ('chat.button.confirm','Confirm','[]'::jsonb),
 ('chat.button.cancel','Cancel','[]'::jsonb),
 ('chat.unmatch.confirm','End this Match and close the chat permanently?','[]'::jsonb),
 ('chat.unlock.confirm','Spend {credits} credits to unlock text chat for both participants?','["credits"]'::jsonb),
 ('chat.message.sent','Message sent.','[]'::jsonb)
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,'message',variables,true,clock_timestamp(),clock_timestamp() FROM seed;
