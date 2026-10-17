WITH seed(text_key,body) AS (VALUES
 ('report.ui.reply_submits',E'Reply to this message to submit your report with details. To submit without details, use Submit report above.'),
 ('report.ui.cancelled',E'This report was cancelled. No report was submitted.')
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,'message','[]'::jsonb,true,clock_timestamp(),clock_timestamp() FROM seed;
