-- English source text for M3. Other locales remain inactive until reviewed translations exist.
WITH seed(text_key, category, body, variables) AS (
  VALUES
    ('explore.title', 'message', 'Explore', '[]'),
    ('explore.empty', 'message', 'No one is available right now.', '[]'),
    ('explore.button.like', 'button', 'Like', '[]'),
    ('explore.button.not_interested', 'button', 'Not interested', '[]'),
    ('explore.guest.limit_reached', 'message', 'You have used all guest previews.', '[]'),
    ('interaction.like.sent', 'message', 'Like sent.', '[]'),
    ('interaction.not_interested.saved', 'message', 'You will not see this person again.', '[]'),
    ('matching.match.created', 'message', 'You matched!', '[]'),
    ('liked_by.empty', 'message', 'No Likes yet.', '[]'),
    ('liked_by.button.unlock', 'button', 'Unlock', '[]'),
    ('liked_by.button.next', 'button', 'Next', '[]'),
    ('error.discovery.failure_reason_invalid', 'error', 'This delivery result was invalid.', '[]'),
    ('error.discovery.provider_message_invalid', 'error', 'This delivery could not be confirmed.', '[]'),
    ('error.discovery.candidate_pool_invalid', 'error', 'Candidate selection is unavailable.', '[]'),
    ('error.discovery.gender_filter_invalid', 'error', 'Choose at least one eligible gender.', '[]'),
    ('error.discovery.age_filter_invalid', 'error', 'Choose an age range from 18 to 120.', '[]'),
    ('error.discovery.age_invalid', 'error', 'This age is invalid.', '[]'),
    ('error.discovery.city_filter_invalid', 'error', 'Choose an eligible city.', '[]'),
    ('error.discovery.delivery_not_found', 'error', 'This discovery delivery is no longer available.', '[]'),
    ('error.discovery.delivery_state_conflict', 'error', 'This discovery delivery has changed.', '[]'),
    ('error.discovery.reservation_in_progress', 'error', 'Please wait for your current card.', '[]'),
    ('error.discovery.unavailable', 'error', 'Discovery is not available right now.', '[]'),
    ('error.discovery.version_conflict', 'error', 'Your Explore settings changed. Refresh and try again.', '[]'),
    ('error.discovery.catalog_invalid', 'error', 'One of your Explore choices is unavailable.', '[]'),
    ('error.interaction.cursor_invalid', 'error', 'This page link expired. Open Liked By again.', '[]'),
    ('error.interaction.pair_invalid', 'error', 'This interaction is unavailable.', '[]'),
    ('error.interaction.like_already_exists', 'error', 'You already liked this person.', '[]'),
    ('error.interaction.not_interested_already_exists', 'error', 'You already marked this person Not Interested.', '[]'),
    ('error.interaction.pair_unavailable', 'error', 'This interaction is no longer available.', '[]'),
    ('error.interaction.unavailable', 'error', 'This action is no longer available.', '[]'),
    ('error.interaction.page_limit_invalid', 'error', 'This page size is invalid.', '[]'),
    ('liked_by.title', 'message', 'Liked By ({count})', '["count"]'),
    ('liked_by.card.locked', 'message', 'Like {position} · Locked', '["position"]')
)
INSERT INTO catalog.ui_texts (
  id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at
)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, variables::jsonb, true,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
FROM seed;
