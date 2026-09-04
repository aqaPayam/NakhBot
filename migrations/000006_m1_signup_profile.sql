CREATE SCHEMA IF NOT EXISTS profile;

CREATE TABLE identity.signup_progress (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  current_step text NOT NULL CHECK (current_step IN ('age_confirmation','name','birth_year','gender','relationship_gender_preference','interests','location','relationship_goal','primary_photo','additional_photos','highlight','optional_details','confirm_profile','completed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL,
  CONSTRAINT signup_progress_completion_ck CHECK ((current_step = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE identity.signup_drafts (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE RESTRICT,
  draft_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(draft_data) = 'object'),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  last_completed_step text CHECK (last_completed_step IS NULL OR last_completed_step IN ('age_confirmation','name','birth_year','gender','relationship_gender_preference','interests','location','relationship_goal','primary_photo','additional_photos','highlight','optional_details')),
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE profile.profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES identity.users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  birth_year integer NOT NULL CHECK (birth_year >= 1900),
  gender_option_id uuid NOT NULL REFERENCES catalog.gender_options(id) ON DELETE RESTRICT,
  gender_preference_id uuid NOT NULL REFERENCES catalog.gender_preferences(id) ON DELETE RESTRICT,
  relationship_goal_id uuid NOT NULL REFERENCES catalog.relationship_goals(id) ON DELETE RESTRICT,
  country_id uuid NOT NULL REFERENCES catalog.countries(id) ON DELETE RESTRICT,
  province_id uuid NOT NULL REFERENCES catalog.provinces(id) ON DELETE RESTRICT,
  city_id uuid NOT NULL REFERENCES catalog.cities(id) ON DELETE RESTRICT,
  highlight text NOT NULL CHECK (char_length(highlight) BETWEEN 1 AND 320),
  bio text CHECK (bio IS NULL OR char_length(bio) <= 2000),
  completion_status text NOT NULL CHECK (completion_status IN ('incomplete','complete','invalid')),
  ever_completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  random_shuffle_key double precision NOT NULL DEFAULT random(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT profile_completion_ck CHECK (
    (completion_status = 'incomplete' AND NOT ever_completed AND completed_at IS NULL)
    OR (completion_status = 'complete' AND ever_completed AND completed_at IS NOT NULL)
    OR (completion_status = 'invalid' AND ever_completed AND completed_at IS NOT NULL)
  )
);

CREATE INDEX profiles_completion_city_birth_idx ON profile.profiles (completion_status, city_id, birth_year);
CREATE INDEX profiles_gender_preference_idx ON profile.profiles (gender_option_id, gender_preference_id);
CREATE INDEX profiles_complete_shuffle_idx ON profile.profiles (city_id, random_shuffle_key, id) WHERE completion_status = 'complete';

CREATE FUNCTION profile.enforce_profile_invariants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.ever_completed AND NOT NEW.ever_completed THEN
    RAISE EXCEPTION 'profile ever_completed cannot be reset' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM catalog.cities city
    JOIN catalog.provinces province ON province.id = city.province_id
    WHERE city.id = NEW.city_id
      AND province.id = NEW.province_id
      AND province.country_id = NEW.country_id
  ) THEN
    RAISE EXCEPTION 'invalid profile location hierarchy' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER profiles_invariants
BEFORE INSERT OR UPDATE ON profile.profiles
FOR EACH ROW EXECUTE FUNCTION profile.enforce_profile_invariants();

CREATE TABLE profile.profile_optional_details (
  profile_id uuid PRIMARY KEY REFERENCES profile.profiles(id) ON DELETE CASCADE,
  height_cm integer CHECK (height_cm IS NULL OR height_cm BETWEEN 100 AND 250),
  job_title text CHECK (job_title IS NULL OR char_length(job_title) <= 256),
  education_level_code text CHECK (education_level_code IS NULL OR education_level_code IN ('high_school_or_less','vocational','associate','bachelor','master','doctorate','other')),
  smoking_preference_code text CHECK (smoking_preference_code IS NULL OR smoking_preference_code IN ('never','occasionally','regularly','trying_to_quit')),
  pets_preference_code text CHECK (pets_preference_code IS NULL OR pets_preference_code IN ('have_pets','want_pets','like_pets','no_pets','allergic')),
  exercise_frequency_code text CHECK (exercise_frequency_code IS NULL OR exercise_frequency_code IN ('never','occasionally','weekly','frequently','daily')),
  religion_importance_code text CHECK (religion_importance_code IS NULL OR religion_importance_code IN ('not_important','somewhat_important','very_important')),
  children_preference_code text CHECK (children_preference_code IS NULL OR children_preference_code IN ('want_children','do_not_want_children','have_and_want_more','have_and_do_not_want_more','not_sure'))
);

CREATE TABLE profile.profile_interests (
  profile_id uuid NOT NULL REFERENCES profile.profiles(id) ON DELETE CASCADE,
  interest_id uuid NOT NULL REFERENCES catalog.interests(id) ON DELETE RESTRICT,
  PRIMARY KEY (profile_id, interest_id)
);
CREATE TABLE profile.profile_languages (
  profile_id uuid NOT NULL REFERENCES profile.profiles(id) ON DELETE CASCADE,
  language_id uuid NOT NULL REFERENCES catalog.languages(id) ON DELETE RESTRICT,
  PRIMARY KEY (profile_id, language_id)
);
CREATE TABLE profile.profile_personality_tags (
  profile_id uuid NOT NULL REFERENCES profile.profiles(id) ON DELETE CASCADE,
  personality_tag_id uuid NOT NULL REFERENCES catalog.personality_tags(id) ON DELETE RESTRICT,
  PRIMARY KEY (profile_id, personality_tag_id)
);

INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at) VALUES
  (md5('en:signup.age_confirmation.prompt')::uuid, 'en', 'signup.age_confirmation.prompt', 'Confirm that you are at least 18 years old.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.name.prompt')::uuid, 'en', 'signup.name.prompt', 'What name should appear on your profile?', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.birth_year.prompt')::uuid, 'en', 'signup.birth_year.prompt', 'What is your Gregorian birth year?', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.gender.prompt')::uuid, 'en', 'signup.gender.prompt', 'Select your gender.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.relationship_gender_preference.prompt')::uuid, 'en', 'signup.relationship_gender_preference.prompt', 'Who would you like to meet?', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.interests.prompt')::uuid, 'en', 'signup.interests.prompt', 'Choose between 5 and 20 interests.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.location.prompt')::uuid, 'en', 'signup.location.prompt', 'Select your country, province, and city.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.relationship_goal.prompt')::uuid, 'en', 'signup.relationship_goal.prompt', 'What kind of relationship are you looking for?', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.primary_photo.prompt')::uuid, 'en', 'signup.primary_photo.prompt', 'Choose your primary photo.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.additional_photos.prompt')::uuid, 'en', 'signup.additional_photos.prompt', 'Add at least one more photo.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.highlight.prompt')::uuid, 'en', 'signup.highlight.prompt', 'Write a short profile highlight.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.optional_details.prompt')::uuid, 'en', 'signup.optional_details.prompt', 'Add optional details or continue.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.confirm_profile.prompt')::uuid, 'en', 'signup.confirm_profile.prompt', 'Review and confirm your profile.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:signup.completed.prompt')::uuid, 'en', 'signup.completed.prompt', 'Your profile is complete.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.signup.step.invalid')::uuid, 'en', 'error.signup.step.invalid', 'This signup step cannot be saved now.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.signup.version_conflict')::uuid, 'en', 'error.signup.version_conflict', 'Your signup changed elsewhere. Resume from the current step.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.signup.catalog_inactive')::uuid, 'en', 'error.signup.catalog_inactive', 'One of the selected options is no longer available.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.signup.location_invalid')::uuid, 'en', 'error.signup.location_invalid', 'Select a valid active country, province, and city.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.signup.draft_invalid')::uuid, 'en', 'error.signup.draft_invalid', 'Your saved signup data cannot be read safely.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.profile.interests.invalid')::uuid, 'en', 'error.profile.interests.invalid', 'Choose between 5 and 20 distinct interests.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.profile.languages.invalid')::uuid, 'en', 'error.profile.languages.invalid', 'Choose at most 10 distinct languages.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.profile.personality_tags.invalid')::uuid, 'en', 'error.profile.personality_tags.invalid', 'Choose at most 5 distinct personality tags.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.signup.optional_details.invalid')::uuid, 'en', 'error.signup.optional_details.invalid', 'One of the optional profile details is invalid.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
