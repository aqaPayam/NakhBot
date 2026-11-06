-- Owned Explore filter presentation; no new retained resources.
WITH seed(text_key,body,variables) AS (VALUES
 (E'filters.any',E'Any relationship goal','[]'::jsonb),
 (E'filters.apply',E'Apply shown filters','[]'::jsonb),
 (E'filters.changed',E'These filters changed. Use the current menu and try again.','[]'::jsonb),
 (E'filters.genders',E'Genders','[]'::jsonb),
 (E'filters.goal',E'Relationship goal','[]'::jsonb),
 (E'filters.invalid',E'Choose at least one available gender, ages 18–120 in order, and an active location.','[]'::jsonb),
 (E'filters.location',E'Location','[]'::jsonb),
 (E'filters.max_age',E'Maximum age','[]'::jsonb),
 (E'filters.min_age',E'Minimum age','[]'::jsonb),
 (E'filters.preference_adjusted',E'Your profile preference changed. The next filter change will also save the available genders shown here.','[]'::jsonb),
 (E'filters.saved',E'Explore filters saved.','[]'::jsonb),
 (E'filters.summary',E'Genders: {genders}\nAge: {min}–{max}\nLocation: {location}\nRelationship goal: {goal}\nChanges save as you tap.','["genders","goal","location","max","min"]'::jsonb),
 (E'filters.title',E'Explore filters','[]'::jsonb)
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,'message',variables,true,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM seed;
