-- M9 signup presentation. Existing private drafts and outbox classification remain authoritative.
WITH seed(text_key,category,body,variables) AS (VALUES
 ('signup.ui.confirm_age', 'button', 'I am at least 18', '[]'::jsonb),
 ('signup.ui.next', 'button', 'Next', '[]'::jsonb),
 ('signup.ui.back', 'button', 'Back', '[]'::jsonb),
 ('signup.ui.continue', 'button', 'Continue', '[]'::jsonb),
 ('signup.ui.confirm', 'button', 'Confirm profile', '[]'::jsonb),
 ('signup.ui.refresh', 'button', 'Check uploads', '[]'::jsonb),
 ('signup.ui.photos', 'message', 'Send photos here, then check uploads once processing finishes. Choose photos in their upload order.', '[]'::jsonb),
 ('signup.ui.photo', 'message', 'Photo {position}', '["position"]'::jsonb),
 ('signup.ui.optional', 'message', 'Optional details', '[]'::jsonb),
 ('signup.ui.remove', 'button', 'Remove this answer', '[]'::jsonb),
 ('signup.ui.height_cm', 'message', 'Height (cm)', '[]'::jsonb),
 ('signup.ui.job', 'message', 'Job', '[]'::jsonb),
 ('signup.ui.education_level_code', 'message', 'Education', '[]'::jsonb),
 ('signup.ui.smoking_preference_code', 'message', 'Smoking', '[]'::jsonb),
 ('signup.ui.pets_preference_code', 'message', 'Pets', '[]'::jsonb),
 ('signup.ui.exercise_frequency_code', 'message', 'Exercise', '[]'::jsonb),
 ('signup.ui.religion_code', 'message', 'Religion', '[]'::jsonb),
 ('signup.ui.children_preference_code', 'message', 'Children', '[]'::jsonb),
 ('signup.ui.language_codes', 'message', 'Spoken languages', '[]'::jsonb),
 ('signup.ui.personality_tag_codes', 'message', 'Personality tags', '[]'::jsonb),
 ('signup.ui.bio', 'message', 'Bio', '[]'::jsonb),
 ('signup.ui.reply', 'message', 'Reply to this message with your answer.', '[]'::jsonb),
 ('signup.ui.choose', 'message', 'Choose an answer below.', '[]'::jsonb),
 ('signup.ui.expired', 'message', 'This prompt is no longer current. Send /start to resume.', '[]'::jsonb),
 ('signup.ui.invalid', 'message', 'That answer could not be saved. Please try the current step again.', '[]'::jsonb),
 ('signup.ui.review', 'message', E'Name: {name}\nBirth year: {year}\nGender: {gender}\nLooking for: {preference}\nInterests: {interests}\nLocation: {location}\nRelationship goal: {goal}\nHighlight: {highlight}\nOptional details:\n{optional}\nPhotos: {photos}', '["name", "year", "gender", "preference", "interests", "location", "goal", "highlight", "optional", "photos"]'::jsonb)
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,category,variables,true,clock_timestamp(),clock_timestamp() FROM seed;
DO $$ DECLARE policy jsonb; BEGIN
 policy:=jsonb_set(platform.deletion_event_policy(),'{shapes,identity.signup-optional-details-saved.v1}','{"required":"userId currentStep draftVersion"}'::jsonb);
 EXECUTE format('CREATE OR REPLACE FUNCTION platform.deletion_event_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS %L','SELECT '||quote_literal(policy::text)||'::jsonb');
END $$;
