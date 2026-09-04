DO $$
BEGIN
  IF (SELECT count(*) FROM catalog.gender_options WHERE is_active) <> 3
    OR (SELECT count(*) FROM catalog.gender_preferences WHERE is_active) <> 3
    OR (SELECT count(*) FROM catalog.relationship_goals WHERE is_active) <> 5
    OR (SELECT count(*) FROM catalog.interests WHERE is_active) <> 30
    OR (SELECT count(*) FROM catalog.languages WHERE is_active) <> 14
    OR (SELECT count(*) FROM catalog.personality_tags WHERE is_active) <> 12 THEN
    RAISE EXCEPTION 'canonical M1 Profile catalog seeds are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM catalog.cities city
    JOIN catalog.provinces province ON province.id = city.province_id
    JOIN catalog.countries country ON country.id = province.country_id
    WHERE country.code = 'iran' AND province.code = 'tehran' AND city.code = 'tehran'
      AND country.is_active AND province.is_active AND city.is_active
  ) THEN
    RAISE EXCEPTION 'deterministic Iran hierarchy fixture is missing';
  END IF;
END
$$;
