-- Canonical M1 Profile/signup catalogs. Stable codes are API/seed identifiers; labels are localized data.
CREATE TABLE catalog.gender_options (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0)
);

CREATE TABLE catalog.gender_preferences (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0)
);

CREATE TABLE catalog.gender_preference_members (
  gender_preference_id uuid NOT NULL REFERENCES catalog.gender_preferences(id) ON DELETE RESTRICT,
  gender_option_id uuid NOT NULL REFERENCES catalog.gender_options(id) ON DELETE RESTRICT,
  PRIMARY KEY (gender_preference_id, gender_option_id)
);

CREATE TABLE catalog.relationship_goals (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0)
);

CREATE TABLE catalog.interests (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0)
);

CREATE TABLE catalog.languages (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0)
);

CREATE TABLE catalog.personality_tags (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0)
);

CREATE TABLE catalog.profile_option_values (
  id uuid PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('education_level', 'smoking_preference', 'pets_preference', 'exercise_frequency', 'religion_importance', 'children_preference')),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0),
  UNIQUE (category, code)
);

CREATE TABLE catalog.countries (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0)
);

CREATE TABLE catalog.provinces (
  id uuid PRIMARY KEY,
  country_id uuid NOT NULL REFERENCES catalog.countries(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0),
  UNIQUE (country_id, code)
);

CREATE TABLE catalog.cities (
  id uuid PRIMARY KEY,
  province_id uuid NOT NULL REFERENCES catalog.provinces(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label_key text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0),
  UNIQUE (province_id, code)
);

CREATE INDEX provinces_country_order_idx ON catalog.provinces (country_id, display_order, id);
CREATE INDEX cities_province_order_idx ON catalog.cities (province_id, display_order, id);

INSERT INTO catalog.gender_options (id, code, label_key, display_order) VALUES
  ('20000000-0000-4000-8000-000000000001', 'man', 'catalog.gender.man', 1),
  ('20000000-0000-4000-8000-000000000002', 'woman', 'catalog.gender.woman', 2),
  ('20000000-0000-4000-8000-000000000003', 'other', 'catalog.gender.other', 3);

INSERT INTO catalog.gender_preferences (id, code, label_key, display_order) VALUES
  ('20000000-0000-4000-8000-000000000011', 'men', 'catalog.gender_preference.men', 1),
  ('20000000-0000-4000-8000-000000000012', 'women', 'catalog.gender_preference.women', 2),
  ('20000000-0000-4000-8000-000000000013', 'everyone', 'catalog.gender_preference.everyone', 3);

INSERT INTO catalog.gender_preference_members (gender_preference_id, gender_option_id) VALUES
  ('20000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000003');

INSERT INTO catalog.relationship_goals (id, code, label_key, display_order) VALUES
  ('20000000-0000-4000-8000-000000000021', 'serious_relationship', 'catalog.relationship_goal.serious_relationship', 1),
  ('20000000-0000-4000-8000-000000000022', 'casual_dating', 'catalog.relationship_goal.casual_dating', 2),
  ('20000000-0000-4000-8000-000000000023', 'friendship', 'catalog.relationship_goal.friendship', 3),
  ('20000000-0000-4000-8000-000000000024', 'marriage', 'catalog.relationship_goal.marriage', 4),
  ('20000000-0000-4000-8000-000000000025', 'not_sure_yet', 'catalog.relationship_goal.not_sure_yet', 5);

INSERT INTO catalog.interests (id, code, label_key, display_order)
SELECT md5('interest:' || code)::uuid, code, 'catalog.interest.' || code, ordering
FROM unnest(ARRAY['travel','music','movies','books','fitness','hiking','cooking','coffee','photography','art','gaming','technology','animals','nature','dancing','fashion','football','volleyball','basketball','running','cycling','swimming','yoga','languages','history','science','entrepreneurship','volunteering','food','cars']) WITH ORDINALITY AS seed(code, ordering);

INSERT INTO catalog.languages (id, code, label_key, display_order)
SELECT md5('language:' || code)::uuid, code, 'catalog.language.' || code, ordering
FROM unnest(ARRAY['persian','english','azerbaijani_turkish','kurdish','luri','gilaki','mazandarani','arabic','armenian','turkmen','balochi','turkish','french','german']) WITH ORDINALITY AS seed(code, ordering);

INSERT INTO catalog.personality_tags (id, code, label_key, display_order)
SELECT md5('personality:' || code)::uuid, code, 'catalog.personality_tag.' || code, ordering
FROM unnest(ARRAY['adventurous','ambitious','calm','creative','curious','family_oriented','funny','kind','outgoing','romantic','thoughtful','independent']) WITH ORDINALITY AS seed(code, ordering);

INSERT INTO catalog.profile_option_values (id, category, code, label_key, display_order)
SELECT md5(category || ':' || code)::uuid, category, code, 'catalog.' || category || '.' || code, ordering
FROM (VALUES
  ('education_level', ARRAY['high_school_or_less','vocational','associate','bachelor','master','doctorate','other']::text[]),
  ('smoking_preference', ARRAY['never','occasionally','regularly','trying_to_quit']::text[]),
  ('pets_preference', ARRAY['have_pets','want_pets','like_pets','no_pets','allergic']::text[]),
  ('exercise_frequency', ARRAY['never','occasionally','weekly','frequently','daily']::text[]),
  ('religion_importance', ARRAY['not_important','somewhat_important','very_important']::text[]),
  ('children_preference', ARRAY['want_children','do_not_want_children','have_and_want_more','have_and_do_not_want_more','not_sure']::text[])
) AS categories(category, codes)
CROSS JOIN LATERAL unnest(codes) WITH ORDINALITY AS seed(code, ordering);

INSERT INTO catalog.countries (id, code, label_key, display_order) VALUES
  ('20000000-0000-4000-8000-000000000101', 'iran', 'catalog.country.iran', 1);
INSERT INTO catalog.provinces (id, country_id, code, label_key, display_order) VALUES
  ('20000000-0000-4000-8000-000000000111', '20000000-0000-4000-8000-000000000101', 'tehran', 'catalog.province.tehran', 1),
  ('20000000-0000-4000-8000-000000000112', '20000000-0000-4000-8000-000000000101', 'isfahan', 'catalog.province.isfahan', 2);
INSERT INTO catalog.cities (id, province_id, code, label_key, display_order) VALUES
  ('20000000-0000-4000-8000-000000000121', '20000000-0000-4000-8000-000000000111', 'tehran', 'catalog.city.tehran', 1),
  ('20000000-0000-4000-8000-000000000122', '20000000-0000-4000-8000-000000000112', 'isfahan', 'catalog.city.isfahan', 1);

-- Fixture geography is intentionally not production-complete. Production activation requires a
-- separately versioned, checksum-verified complete Iran province/city dataset.

INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || label_key)::uuid, 'en', label_key,
       initcap(replace(split_part(label_key, '.', array_length(string_to_array(label_key, '.'), 1)), '_', ' ')),
       'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
FROM (
  SELECT label_key FROM catalog.gender_options UNION ALL
  SELECT label_key FROM catalog.gender_preferences UNION ALL
  SELECT label_key FROM catalog.relationship_goals UNION ALL
  SELECT label_key FROM catalog.interests UNION ALL
  SELECT label_key FROM catalog.languages UNION ALL
  SELECT label_key FROM catalog.personality_tags UNION ALL
  SELECT label_key FROM catalog.profile_option_values UNION ALL
  SELECT label_key FROM catalog.countries UNION ALL
  SELECT label_key FROM catalog.provinces UNION ALL
  SELECT label_key FROM catalog.cities
) AS labels;
