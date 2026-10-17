WITH seed(text_key,category,body,variables) AS (VALUES
 ('profile.ui.more','button',E'Show More','[]'::jsonb),
 ('profile.ui.details','message',E'{name}, approximately {age}\n{location}\nGender: {gender}\nLooking for: {preference}\nRelationship goal: {goal}\nInterests: {interests}\n{highlight}\n{optional}\n{bio}','["name", "age", "location", "gender", "preference", "goal", "interests", "highlight", "optional", "bio"]'::jsonb),
 ('profile.ui.optional','message',E'{label}: {value}','["label", "value"]'::jsonb),
 ('profile.ui.photo','message',E'{name} · Photo {position} of {total}','["name", "position", "total"]'::jsonb)
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,category,variables,true,clock_timestamp(),clock_timestamp() FROM seed;
