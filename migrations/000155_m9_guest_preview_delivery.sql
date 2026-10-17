WITH seed(text_key,category,body,variables) AS (VALUES
 ('preview.ui.card','message',E'{name}, approximately {age}\n{city}\n{highlight}','["name","age","city","highlight"]'::jsonb),
 ('preview.ui.next','button','Next profile','[]'::jsonb),
 ('preview.ui.pending','message','This delivery is awaiting verification. Please use /start to continue signup or contact support if it remains pending.','[]'::jsonb),
 ('preview.ui.failed','message','This profile could not be delivered. Choose Guest Preview again to try another delivery.','[]'::jsonb),
 ('preview.ui.handled','message','This profile was already delivered. Use the buttons on your current card or send /start.','[]'::jsonb)
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,category,variables,true,clock_timestamp(),clock_timestamp() FROM seed;

-- A lost/expired response does not prove that Telegram rejected the photo.
-- Preserve the original reservation until trusted outcome settlement; in
-- particular, product purge must not forget a possibly accepted guest card.
CREATE FUNCTION discovery.guard_candidate_provider_erase() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state='reserved' AND OLD.attempt_count>0 THEN
  RAISE EXCEPTION 'candidate provider outcome is unresolved' USING ERRCODE='55000';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER candidate_provider_erase_guard BEFORE DELETE ON discovery.candidate_deliveries
 FOR EACH ROW EXECUTE FUNCTION discovery.guard_candidate_provider_erase();
