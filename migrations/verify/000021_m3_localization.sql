DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
        'explore.title', 'explore.empty', 'explore.button.like',
        'explore.button.not_interested', 'explore.guest.limit_reached',
        'interaction.like.sent', 'interaction.not_interested.saved',
        'matching.match.created', 'liked_by.empty', 'liked_by.button.unlock',
        'liked_by.button.next', 'liked_by.title', 'liked_by.card.locked',
        'error.discovery.failure_reason_invalid',
        'error.discovery.provider_message_invalid',
        'error.discovery.candidate_pool_invalid',
        'error.discovery.gender_filter_invalid',
        'error.discovery.age_filter_invalid', 'error.discovery.age_invalid',
        'error.discovery.city_filter_invalid', 'error.discovery.delivery_not_found',
        'error.discovery.delivery_state_conflict',
        'error.discovery.reservation_in_progress', 'error.discovery.unavailable',
        'error.discovery.version_conflict', 'error.discovery.catalog_invalid',
        'error.interaction.cursor_invalid', 'error.interaction.pair_invalid',
        'error.interaction.like_already_exists',
        'error.interaction.not_interested_already_exists',
        'error.interaction.pair_unavailable', 'error.interaction.unavailable',
        'error.interaction.page_limit_invalid'
      ]) AS expected(text_key)
    LEFT JOIN catalog.ui_texts actual ON actual.locale_code = 'en'
      AND actual.text_key = expected.text_key AND actual.is_active
    WHERE actual.id IS NULL
  ) THEN
    RAISE EXCEPTION 'M3 localization seed is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts
    WHERE locale_code = 'en' AND text_key = 'liked_by.title'
      AND variables = '["count"]'::jsonb
  ) OR NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts
    WHERE locale_code = 'en' AND text_key = 'liked_by.card.locked'
      AND variables = '["position"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'M3 localization variables are invalid';
  END IF;
END $$;
