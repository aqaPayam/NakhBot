# Domain Attributes and Configuration

This document defines logical entity-owned data and the finalized MVP defaults. Database types, foreign keys, check constraints, and indexes must preserve these meanings.

Unless stated otherwise, persisted entities have a system-generated `id` and appropriate `created_at` / `updated_at` timestamps. All timestamps are UTC.

## 1. Identity, account, and signup

### User

- `id`
- `last_activity_at`

### TelegramIdentity

- `user_id`
- `telegram_user_id` — required and globally unique
- `telegram_username` — nullable and mutable
- `first_seen_at`
- `last_seen_at`

### Account

- `user_id` — unique
- `state`
- `state_reason`
- `state_changed_at`

State-specific timestamps are derived from AccountStateHistory and should not be duplicated unless needed as indexed projections.

### AccountStateHistory

- `user_id`
- `previous_state`
- `next_state`
- `reason_code`
- `actor_type`
- `actor_user_id` — nullable
- `actor_admin_id` — nullable
- `changed_at`

Exactly one actor reference is set when actor type is user or admin; neither is set for a system action.

### AccountDeletionRecord

- `user_id`
- `requested_at`
- `purge_started_at`
- `product_data_purged_at`
- `chats_closed_at`
- `completed_at`
- `reactivation_allowed`
- `failure_detail` — nullable operational detail

### GuestPreviewCounter

- `user_id` — unique
- `preview_count` — starts at 0
- `limit_count` — snapshot of the configured limit, 10 for new MVP users
- `first_preview_at` — nullable
- `last_preview_at` — nullable

Telegram user ID is not duplicated here; it is resolved through User and TelegramIdentity.

### UserSettings

- `user_id` — unique
- `visibility_enabled` — default true
- `ui_locale_code` — default `en`

### SignupProgress

- `user_id` — unique for the current signup
- `current_step`
- `started_at`
- `completed_at` — nullable

### SignupDraft

- `user_id` — unique for the current signup
- `draft_data` — validated structured values only
- `last_completed_step`
- `expires_at` — nullable; MVP does not automatically expire drafts

## 2. Profile catalogs, Profile, and location

### GenderOption

- `code` — unique stable code
- `label_key`
- `is_active`
- `display_order`

### GenderPreference

- `code` — unique stable code
- `label_key`
- `is_active`
- `display_order`

### GenderPreferenceMember

- `gender_preference_id`
- `gender_option_id`

The pair is unique.

### Profile

- `user_id` — unique for the current Profile
- `name`
- `birth_year` — integer Gregorian year
- `gender_option_id`
- `gender_preference_id`
- `relationship_goal`
- `country_id`
- `province_id`
- `city_id`
- `highlight`
- `bio` — nullable
- `completion_status`
- `ever_completed` — immutable true after first completion
- `completed_at` — nullable
- `random_shuffle_key`

`age` is never stored as source-of-truth data.

### ProfileOptionalDetails

- `profile_id` — unique
- `height_cm` — nullable
- `job_title` — nullable
- `education_level` — nullable
- `smoking_preference` — nullable
- `pets_preference` — nullable
- `exercise_frequency` — nullable
- `religion_importance` — nullable
- `children_preference` — nullable

Validation defaults:

- `height_cm`: integer from 100 through 250
- `job_title`: at most 64 characters after normalization
- spoken languages: at most 10 distinct active selections
- personality tags: at most 5 distinct active selections

### Interest, Language, and PersonalityTag

Each option owns:

- `code` — unique
- `label_key`
- `is_active`
- `display_order`

Required active MVP Interest seed codes:

`travel`, `music`, `movies`, `books`, `fitness`, `hiking`, `cooking`, `coffee`, `photography`, `art`, `gaming`, `technology`, `animals`, `nature`, `dancing`, `fashion`, `football`, `volleyball`, `basketball`, `running`, `cycling`, `swimming`, `yoga`, `languages`, `history`, `science`, `entrepreneurship`, `volunteering`, `food`, and `cars`.

Required active MVP spoken-language seed codes:

`persian`, `english`, `azerbaijani_turkish`, `kurdish`, `luri`, `gilaki`, `mazandarani`, `arabic`, `armenian`, `turkmen`, `balochi`, `turkish`, `french`, and `german`.

Required active MVP PersonalityTag seed codes:

`adventurous`, `ambitious`, `calm`, `creative`, `curious`, `family_oriented`, `funny`, `kind`, `outgoing`, `romantic`, `thoughtful`, and `independent`.

Seed labels and ordering are localized data and MAY be revised without changing the stable codes or Profile behavior.

### ProfileInterest, ProfileLanguage, and ProfilePersonalityTag

Each join owns its two parent IDs. Each parent pair is unique.

### ProfileChangeRequest

- `user_id`
- `field_name`
- `old_value_snapshot`
- `requested_value`
- `reason`
- `status`
- `submitted_at`
- `resolved_at` — nullable

Only one pending request per User/field is allowed.

### ProfileChangeReview

- `request_id` — unique
- `admin_user_id`
- `decision`
- `admin_note` — nullable
- `reviewed_at`

### Country

- `code` — unique
- `label_key`
- `is_active`

### Province

- `country_id`
- `code`
- `label_key`
- `is_active`
- `display_order`

Country/code is unique.

### City

- `province_id`
- `code`
- `label_key`
- `is_active`
- `display_order`

Province/code is unique.

## 3. Media

### MediaAsset

- `owner_user_id`
- `original_filename`
- `detected_mime_type`
- `file_size_bytes`
- `width_px`
- `height_px`
- `content_hash`
- `normalized_image_hash` — nullable
- `storage_provider`
- `storage_key`
- `cdn_url`
- `validation_status`
- `validation_error_code` — nullable
- `uploaded_at`
- `storage_deleted_at` — nullable

### ProfilePhoto

- `profile_id`
- `media_asset_id` — unique
- `status`
- `is_primary`
- `display_order`
- `visible_at` — nullable until processing completes
- `hidden_at` — nullable
- `deleted_at` — nullable

### PhotoVariant

- `media_asset_id`
- `variant_type`
- `storage_key`
- `cdn_url`
- `width_px`
- `height_px`
- `generated_at`

MediaAsset/variant type is unique.

### PhotoModerationRecord

- `profile_photo_id`
- `action_type`
- `admin_user_id`
- `report_id` — nullable
- `reason`
- `created_at`

## 4. Explore and interactions

### ExploreFilter

- `user_id` — unique
- `target_gender_option_ids` — non-empty set of current browsing choices
- `min_age`
- `max_age`
- `city_id`
- `relationship_goal` — nullable

The target gender set only narrows reciprocal eligibility. It never writes Profile.gender_preference_id.

### ExploreConsumption

- `viewer_user_id`
- `target_user_id`
- `reason`
- `consumed_at`

Viewer/target is unique regardless of reason.

### Like

- `sender_user_id`
- `receiver_user_id`
- `status`
- `created_at`
- `closed_at` — nullable

Sender/receiver is unique during the current account lifetime.

### NotInterested

- `sender_user_id`
- `receiver_user_id`
- `source`
- `created_at`

Sender/receiver is unique during the current account lifetime.

### UserPairState

- `user_low_id`
- `user_high_id`
- `state`
- `reason_code`
- `changed_at`

The normalized pair is unique and `user_low_id < user_high_id`.

### FeatureUnlock

- `payer_user_id`
- `feature_type`
- `like_id` — nullable
- `match_id` — nullable
- `payment_record_id` — nullable
- `credit_transaction_id` — nullable
- `status`
- `unlocked_at`
- `revoked_at` — nullable
- `revocation_reason` — nullable
- `expires_at` — nullable, always null for MVP-created unlocks

Exactly one scope is set: Like for `liked_by_profile_unlock`, Match for `chat_unlock`. Exactly one funding reference is set. There may be at most one successful unlock of each type for its scope.

## 5. Nakh

### NakhFlow

- `sender_user_id`
- `receiver_user_id`
- `created_at`

Sender/receiver is unique during the current account lifetime.

### PendingNakh

- `nakh_flow_id` — unique
- `text`
- `status`
- `pending_payment_id` — nullable
- `auto_settle_authorized_at`
- `created_at`
- `expires_at`
- `paid_at` — nullable
- `cancelled_at` — nullable
- `cancel_resolution` — nullable
- `last_reminder_at` — nullable

### Nakh

- `nakh_flow_id` — unique
- `text` — immutable delivered copy
- `status`
- `sent_at`
- `seen_at` — nullable
- `accepted_at` — nullable
- `rejected_at` — nullable
- `closed_at` — nullable
- `expired_at` — nullable

### NakhStatusHistory

- `nakh_id`
- `previous_status`
- `next_status`
- `reason_code`
- `changed_at`

### NakhReceiverAction

- `nakh_id`
- `receiver_user_id`
- `action_type`
- `created_at`

Idempotency constraints prevent duplicate terminal receiver actions.

## 6. Match and chat

### Match

- `user_low_id`
- `user_high_id`
- `source`
- `source_like_ids` — set only for mutual Like
- `source_nakh_id` — set only for Nakh acceptance
- `status`
- `created_at`
- `closed_at` — nullable

The normalized pair is unique during the current account lifetime.

### MatchParticipant

- `match_id`
- `user_id`
- `joined_at`

Match/User is unique; every Match has exactly two participants.

### UnmatchRecord

- `match_id` — unique
- `unmatched_by_user_id`
- `reason` — nullable
- `unmatched_at`
- `report_window_expires_at`

### ChatSession

- `match_id` — unique
- `status`
- `created_at`
- `closed_at` — nullable
- `closed_reason` — nullable

### ChatParticipant

- `chat_session_id`
- `user_id`
- `last_read_at` — nullable
- `muted_at` — nullable
- `unlock_safety_warning_shown_at` — nullable

Chat/User is unique; every ChatSession has exactly two participants.

### ChatMessage

- `chat_session_id`
- `sender_user_id` — nullable only for system messages
- `message_type`
- `text` — set only for text/system messages
- `predefined_question_id` — nullable
- `predefined_answer_id` — nullable
- `created_at`

Exactly the payload appropriate to message_type is set.

### ChatMessageSnapshot

- `report_id`
- `chat_session_id`
- `original_message_id`
- `sender_user_id`
- `message_type`
- `content_snapshot`
- `original_created_at`
- `snapshotted_at`

### PredefinedQuestionSet

- `code`
- `title_key`
- `is_active`
- `display_order`

### PredefinedQuestion

- `question_set_id`
- `text_key`
- `is_active`
- `display_order`

### PredefinedAnswer

- `question_id`
- `text_key`
- `is_active`
- `display_order`

Required MVP question-set seed codes and English content:

| Code | Question | Answer choices |
|---|---|---|
| `relationship_intent` | What are you looking for here? | Serious relationship; Something casual; Friendship; Marriage; Still figuring it out |
| `ideal_first_date` | What sounds like an ideal first date? | Coffee and conversation; A walk outdoors; Dinner; A fun activity; Surprise me |
| `chat_frequency` | How often do you like to chat? | Throughout the day; A few times a day; One daily check-in; Whenever we are both free |
| `social_energy` | How would you describe your social energy? | Introvert; Mostly introvert; A mix; Mostly extrovert; Extrovert |
| `weekend_habits` | What does your ideal weekend look like? | Staying in; Friends or family; Exploring the city; Nature or adventure; Working on hobbies |
| `calls_or_texting` | How do you prefer to communicate? | Mostly text; Mostly calls; A mix; Voice messages; It depends |
| `important_values` | Which value matters most to you? | Honesty; Kindness; Ambition; Family; Humor |
| `meeting_in_person` | When would you feel comfortable meeting? | After a few good conversations; Within a week; I prefer to take more time; Video call first |
| `relationship_pace` | What relationship pace feels right? | Slow and steady; Let it happen naturally; Intentional and fast; It depends on the connection |
| `current_life_focus` | What is your main focus right now? | Career or studies; Family; Health and growth; Fun and new experiences; Finding balance |

The table defines seed meaning. Production text is stored through localization keys, not copied into chat handlers.

## 7. Credits and payments

### CreditAccount

- `user_id` — unique
- `balance` — non-negative integer

### CreditTransaction

- `credit_account_id`
- `user_id`
- `transaction_type`
- `amount` — signed integer
- `balance_before`
- `balance_after`
- `payment_record_id` — nullable
- `pending_payment_id` — nullable
- `feature_unlock_id` — nullable
- `nakh_id` — nullable
- `idempotency_key` — unique
- `created_at`

### CreditPackage

- `code` — unique
- `title_key`
- `credit_amount`
- `stars_price`
- `badge_key` — nullable
- `is_active`
- `display_order`

### PendingPayment

- `user_id`
- `reason`
- `target_type`
- `target_id`
- `required_credits` — nullable
- `required_stars` — nullable
- `status`
- `created_at`
- `expires_at`
- `resolved_at` — nullable

### PaymentRecord

- `user_id`
- `pending_payment_id` — nullable
- `payment_type`
- `paid_action_reason` — nullable for package purchase
- `credit_package_id` — nullable
- `status`
- `stars_amount`
- `provider`
- `invoice_payload` — unique
- `provider_payment_id` — nullable and unique
- lifecycle timestamps: `created_at`, `paid_at`, `failed_at`, `cancelled_at`, `refunded_at`

### TelegramStarsPayment

- `payment_record_id` — unique
- `telegram_charge_id` — unique
- `provider_charge_id` — nullable
- `stars_amount`
- `received_at`
- `raw_data`

### PaymentProviderEvent

- `provider`
- `provider_event_id` — unique
- `event_type`
- `payment_record_id` — nullable
- `raw_payload`
- `received_at`
- `processed_at` — nullable
- `processing_status`
- `failure_detail` — nullable

### RefundRecord

- `user_id`
- `payment_record_id` — nullable
- `credit_transaction_id` — nullable
- `reason_code`
- `stars_amount` — nullable
- `credits_amount` — nullable
- `status`
- `idempotency_key` — unique
- `created_at`
- `processed_at` — nullable

## 8. Notifications

### Notification

- `user_id`
- `notification_type`
- `title_key`
- `body_key`
- `payload`
- `status`
- `created_at`
- `read_at` — nullable
- `deduplication_key` — nullable and unique when set

### NotificationDelivery

- `notification_id`
- `channel`
- `status`
- `attempt_number`
- `next_attempt_at` — nullable
- `sent_at` — nullable
- `failed_at` — nullable
- `failure_code` — nullable

### NotificationPreference

- `user_id` — unique
- mute booleans for `chat`, `like`, `nakh`, and `match`

## 9. Moderation, admin, support, and appeal

### ReportReason

- `code` — unique
- `label_key`
- `is_active`
- `display_order`

### Report

- `reporter_user_id`
- `target_user_id`
- `reason_id`
- `extra_text` — nullable
- `status`
- lifecycle timestamps: `submitted_at`, `reviewed_at`, `closed_at`

### ReportEvidence

- `report_id`
- `evidence_type`
- exactly one appropriate reference among `profile_id`, `profile_photo_id`, `chat_session_id`, `chat_message_id`, and `unmatch_record_id`

### ReportSnapshot

- `report_id`
- `snapshot_type`
- `snapshot_data`
- `created_at`
- `content_hash`

### ModerationReview

- `report_id` — unique
- `admin_user_id` — nullable until assigned
- `status`
- `decision_note` — nullable
- `started_at` — nullable
- `completed_at` — nullable

### ModerationAction

- `actor_type`
- `admin_user_id` — nullable for system threshold action
- `target_user_id`
- `target_profile_photo_id` — nullable
- `report_id` — nullable
- `action_type`
- `reason`
- `created_at`

### AdminUser and authorization

- AdminUser: `user_id`, `telegram_user_id`, `is_active`, `disabled_at`
- AdminRole: `code`, `description`, `is_active`
- AdminPermission: `code`, `description`
- AdminUserRole and AdminRolePermission: unique parent pairs

### AdminActionLog

- `admin_user_id`
- `command_code`
- `target_type`
- `target_id`
- `result`
- `metadata`
- `created_at`

### SupportThread and SupportMessage

- SupportThread: `user_id`, `status`, `last_message_at`, `closed_at`
- SupportMessage: `support_thread_id`, exactly one sender reference, `message_text`, `created_at`

### UserAppeal

- `user_id`
- `ban_state_history_id` — unique
- `message_text`
- `status`
- `reviewed_by_admin_id` — nullable
- `admin_note` — nullable
- `submitted_at`
- `reviewed_at` — nullable

## 10. Localization, jobs, audit, retention, and rate limits

### Locale and UIText

- Locale: `code`, `name`, `is_active`, `is_default`
- UIText: `locale_id`, `text_key`, `text_value`, `category`, `is_active`

Locale/text key is unique.

### ScheduledJob and JobRunLog

- ScheduledJob: `job_type`, `is_active`, `schedule_config`, `last_run_at`, `next_run_at`
- JobRunLog: `scheduled_job_id`, `status`, `started_at`, `finished_at`, `error_detail`, `metadata`

### Audit records

- AuditLog: actor, event type, entity reference, metadata, timestamp
- PaymentAuditLog: User, PaymentRecord, event type, metadata, timestamp
- SafetyAuditLog: User, optional Report, event type, metadata, timestamp

### DataRetentionRecord

- `user_id`
- `deletion_record_id`
- `retained_data_type`
- `legal_or_safety_reason`
- `retention_expires_at` — nullable only when indefinite retention is justified
- `deleted_at` — nullable

### RateLimitRecord

- `user_id`
- `action_type`
- `window_started_at`
- `action_count`
- `blocked_until` — nullable

### SystemConfig

- `config_key` — unique
- `config_value`
- `value_type`
- `description`
- `is_active`
- `updated_by_admin_id` — nullable
- `updated_at`

SystemConfig has no per-setting columns.

## 11. Final MVP configuration defaults

| Key | Value |
|---|---:|
| `guest_preview_limit` | 10 |
| `min_signup_age` | 18 |
| `min_birth_year` | 1900 |
| `name_max_length` | 32 characters |
| `change_request_reason_max_length` | 1024 characters |
| `job_title_max_length` | 64 characters |
| `min_height_cm` | 100 |
| `max_height_cm` | 250 |
| `max_profile_languages` | 10 |
| `max_personality_tags` | 5 |
| `min_profile_photos` | 2 |
| `max_profile_photos` | 6 |
| `min_interests` | 5 |
| `max_interests` | 20 |
| `highlight_max_length` | 80 characters |
| `bio_max_length` | 500 characters |
| `explore_candidate_pool_limit` | 100 |
| `explore_shuffle_key_refresh_hours` | 6 |
| `nakh_text_max_length` | 240 characters |
| `nakh_credit_cost` | 2 |
| `nakh_direct_stars_price` | 2 |
| `pending_nakh_expiry_days` | 14 |
| `sent_nakh_expiry_days` | 14 |
| `pending_nakh_reminder_interval_hours` | 48 |
| `max_unpaid_pending_nakhes_per_sender` | 5 |
| `liked_by_unlock_credit_cost` | 4 |
| `liked_by_unlock_direct_stars_price` | 4 |
| `liked_by_unlock_expiry` | none |
| `chat_unlock_credit_cost` | 4 |
| `chat_unlock_direct_stars_price` | 4 |
| `chat_unlock_expiry` | none |
| `chat_visible_message_limit` | 50 |
| `chat_text_max_length` | 1000 characters |
| `post_unmatch_report_window_hours` | 24 |
| `report_threshold_unique_reporters` | 5 |
| `report_threshold_window_days` | 30 |
| `report_extra_text_max_length` | 1024 characters |
| `support_unanswered_message_limit` | 2 |
| `support_message_max_length` | 2000 characters |
| `appeal_message_max_length` | 2000 characters |
| `report_submit_limit_per_24_hours` | 10 |
| `photo_upload_limit_per_24_hours` | 20 |
| `payment_attempt_limit_per_10_minutes` | 10 |
| `max_photo_file_size_mb` | 10 |
| `min_photo_width_px` | 600 |
| `min_photo_height_px` | 600 |
| `allowed_photo_mime_types` | image/jpeg, image/png, image/webp |
| `required_photo_variants` | thumbnail |
| `media_storage_provider` | cloudflare_r2 |
| `media_cdn_provider` | cloudflare |

MVP CreditPackage seed rows:

| Code | Credits | Stars | Badge | Order |
|---|---:|---:|---|---:|
| `starter` | 10 | 10 | none | 1 |
| `plus` | 25 | 20 | Popular | 2 |
| `best_value` | 50 | 35 | Best Value | 3 |
| `ultimate` | 100 | 60 | Best Value | 4 |

Configuration is read by services and jobs, never copied into handlers. Secrets and bootstrap admin IDs belong to deployment secret configuration, not SystemConfig.
