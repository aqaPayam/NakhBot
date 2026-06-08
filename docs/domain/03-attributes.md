# Domain Attributes

This file lists the attributes owned by each domain entity.

These are domain-level attributes, not final database columns. Database types, constraints, indexes, and migrations will be designed later.

## 1. Identity and Account Attributes

### User

* id
* created_at
* updated_at
* last_activity_at
* is_deleted_logically

### TelegramIdentity

* id
* user_id
* telegram_user_id
* telegram_username
* first_seen_at
* last_seen_at

Notes:

* `telegram_user_id` is stable.
* `telegram_username` is optional and mutable.

### Account

* id
* user_id
* state
* state_reason
* restricted_at
* banned_at
* deleted_at
* reactivated_at

Allowed states:

* guest
* incomplete
* active
* restricted
* banned
* deleted

### AccountStateHistory

* id
* user_id
* old_state
* new_state
* reason
* changed_by_admin_id
* changed_at

### AccountDeletionRecord

* id
* user_id
* deleted_at
* deletion_reason
* requested_by_user
* profile_hidden_at
* chats_closed_at
* reactivation_allowed

### GuestPreviewCounter

* id
* user_id
* telegram_user_id
* preview_count
* limit_count
* first_preview_at
* last_preview_at

Rule:

* Guest and incomplete users share the same permanent preview counter.
* GuestPreviewCounter is created on first `/start` for every new Telegram identity.
* `preview_count` starts at 0.
* `limit_count` is 10 for MVP.
* The counter is not reset when the user starts signup.
* The counter stops controlling Explore access after the account becomes `active`.

### UserSettings

* id
* user_id
* visibility_enabled
* language_code
* created_at
* updated_at


Notes:

* Visibility is stored only as `visibility_enabled`.
* There is no separate `VisibilityStatus` enum in MVP.
* Visibility off is not the same as restricted, banned, deleted, or photo hidden.
* Notification settings are stored in `NotificationPreference`, not here.

### UserBlock

* id
* blocker_user_id
* blocked_user_id
* reason
* source
* created_at
* removed_at

Possible sources:

* user_action
* moderation
* unmatch
* safety

## 2. Signup Attributes

### SignupProgress

* id
* user_id
* current_step
* started_at
* updated_at
* completed_at
* is_completed

Allowed signup steps:

* age_confirmation
* name
* birth_year
* gender
* interested_gender
* interests
* location
* relationship_goal
* primary_photo
* additional_photos
* highlight
* optional_details
* confirm_profile
* completed

### SignupDraft

* id
* user_id
* draft_data
* last_step
* updated_at

Purpose:

* Stores temporary signup answers before final profile completion.

## 3. Profile and Location Attributes

### Profile

* id
* user_id
* name
* birth_year
* gender
* interested_gender
* relationship_goal
* country_id
* province_id
* city_id
* highlight
* bio
* completion_status
* completed_at
* created_at
* updated_at

Notes:

* Telegram identity does not belong to `Profile`.
* Account state does not belong to `Profile`.
* Age is derived from `birth_year`, not stored directly.
* `birth_year` uses the Gregorian calendar.
* `completion_status` is the profile completion source of truth.
* Allowed completion statuses are `incomplete`, `complete`, and `invalid`.
* `is_completed` should be treated as a derived application-level value, not stored as the source of truth.
* `interested_gender` is one profile-level field. Updating it from Explore filters or Edit Profile changes the same value.
* `gender` and `interested_gender` must support extensible compatibility logic.
* `interested_gender` should be interpreted through a configurable mapping to allowed gender options.
* Explore eligibility must check reciprocal gender compatibility:
  * target gender is included in viewer interested-gender mapping
  * viewer gender is included in target interested-gender mapping
* `completion_status = invalid` is used when a previously complete profile becomes invalid, for example because moderation hides photos and the profile no longer has enough visible photos.

### ProfileOptionalDetails

* id
* profile_id
* height_cm
* job_title
* education
* smoking_preference
* pets
* exercise_gym
* religion_importance
* children_preference
* created_at
* updated_at

Notes:

* These fields are optional.
* Exact enum values for optional fields are not finalized yet.

### Interest

* id
* name
* is_active
* display_order
* created_at
* updated_at

### ProfileInterest

* id
* profile_id
* interest_id
* created_at

Rules:

* Interests belong to the dating profile, not directly to the user.
* A complete profile must have at least 5 interests.
* A profile can have at most 20 interests.

### ProfileChangeRequest

* id
* user_id
* field_name
* old_value
* requested_value
* reason
* status
* created_at
* reviewed_at

Allowed fields:

* birth_year
* gender

### ProfileChangeReview

* id
* request_id
* admin_user_id
* decision
* admin_note
* reviewed_at

Decisions:

* approved
* rejected

### Language

* id
* name
* code
* is_active
* display_order

### ProfileLanguage

* id
* profile_id
* language_id
* created_at

### PersonalityTag

* id
* name
* is_active
* display_order

### ProfilePersonalityTag

* id
* profile_id
* personality_tag_id
* created_at

### Country

* id
* name
* code
* is_active

MVP rule:

* Iran is the only supported country.

### Province

* id
* country_id
* name
* is_active
* display_order

### City

* id
* province_id
* name
* is_active
* display_order

Rules:

* City must come from a fixed list.
* Free-text city is not allowed.
* “Other” city is not allowed in MVP.

## 4. Media Attributes

### MediaAsset

* id
* owner_user_id
* original_file_name
* mime_type
* file_size
* storage_provider
* storage_key
* cdn_url
* uploaded_at
* deleted_at

Notes:

* Photos are stored in object storage.
* The app server is not the permanent image store.
* CDN URL is used for media delivery.

### ProfilePhoto

* id
* profile_id
* media_asset_id
* is_primary
* status
* display_order
* uploaded_at
* hidden_at
* deleted_at

Allowed statuses:

* visible
* hidden
* deleted

Rules:

* Minimum visible profile photos for completion: 2
* Maximum profile photos accepted from the user: 6
* Extra uploaded photos are rejected.
* Hidden or deleted photos do not count toward profile completion.
* One photo must always be primary.
* User cannot delete the primary photo before choosing another primary photo.
* If admin hides the primary photo, profile validity must be rechecked.

### PhotoVariant

* id
* media_asset_id
* variant_type
* storage_key
* cdn_url
* created_at

Variant types:

* thumbnail
* blurred_preview

### PhotoModerationRecord

* id
* photo_id
* action_type
* reason
* admin_user_id
* report_id
* created_at

Action types:

* hidden
* restored
* deleted

## 5. Explore and Interaction Attributes

### ExploreFilter

* id
* user_id
* min_age
* max_age
* country_id
* province_id
* city_id
* relationship_goal
* updated_at

Notes:

* `interested_gender` is not stored here.
* `interested_gender` belongs to `Profile`.
* Changing interested gender from Explore or Edit Profile updates the same profile-level value.

### ExploreConsumption

* id
* viewer_user_id
* target_user_id
* reason
* created_at

Allowed reasons:

* preview
* like
* not_interested
* pending_nakh
* sent_nakh
* match

Rule:

* Once consumed, the target profile is not shown again to the same viewer.

### ExploreSession

* id
* user_id
* started_at
* ended_at
* shown_count

Notes:

* Optional for first implementation.
* Useful for analytics, debugging, and abuse detection.

### Like

* id
* sender_user_id
* receiver_user_id
* status
* created_at
* closed_at

Allowed statuses:

* active
* cancelled
* closed_by_match
* closed_by_unmatch

Rules:

* Normal Like appears in receiver’s Liked By.
* Nakh does not create a normal Like automatically.

### NotInterested

* id
* sender_user_id
* receiver_user_id
* source
* created_at

Allowed sources:

* explore
* liked_by
* cancelled_pending_nakh
* unmatch

### UserPairState

* id
* user_a_id
* user_b_id
* state
* updated_at

Allowed states:

* none
* viewed
* liked
* not_interested
* pending_nakh
* nakh_sent
* matched
* unmatched
* blocked

Rule:

* Use normalized pair ordering: `user_a_id < user_b_id`.

Notes:

* `UserPairState` is a summary entity.
* It does not replace `Like`, `NotInterested`, `PendingNakh`, `Nakh`, `Match`, or `UnmatchRecord`.

### FeatureUnlock

* id
* user_id
* feature_type
* target_user_id
* match_id
* payment_id
* credit_transaction_id
* status
* unlocked_at
* expires_at
* revoked_at

Feature types:

* liked_by_profile_unlock
* chat_unlock

Allowed statuses:

* active
* expired
* revoked

Rules:

* `liked_by_profile_unlock` expires according to configured unlock duration.
* `chat_unlock` is scoped to one Match.
* One successful `chat_unlock` unlocks free-text chat for both users in that Match.
* The other matched user does not need to pay again for the same Match.
* `chat_unlock` does not expire in MVP.
* `chat_unlock` remains active until the Match is unmatched, closed by admin/moderation, or closed because of account deletion or ban.
* Expiry configuration applies to `liked_by_profile_unlock`, not to `chat_unlock` in MVP.
* FeatureUnlock is not used for sent Nakh. Nakh is a paid action, not persistent feature access.

## 6. Nakh Attributes

### PendingNakh

* id
* sender_user_id
* receiver_user_id
* text
* pending_payment_id
* status
* created_at
* updated_at
* expires_at
* cancelled_at
* cancel_resolution

Allowed statuses:

* pending_payment
* paid_and_sent
* cancelled
* expired
* abandoned

Allowed cancel resolutions:

* converted_to_like
* converted_to_not_interested
* abandoned

Rules:

* Pending Nakh is visible only to the sender.
* Pending Nakh does not notify the receiver.
* Pending Nakh does not create a normal Like.
* Pending Nakh does not appear in Liked By.
* Pending Nakh does not appear in the receiver’s Nakhes.
* Pending Nakh does not create a Match.
* Pending Nakh consumes the target profile.
* Pending Nakh text can be edited before payment.
* Pending Nakh expires if it is not paid within the configured expiry duration.
* Exact Pending Nakh expiry duration is configurable and must not be hardcoded in handlers.
* If cancelled before payment, the sender must choose whether to convert it to a normal Like or mark the target as Not Interested.
* A visibility-off sender cannot create a new Pending Nakh.
* A visibility-off sender may complete payment for a Pending Nakh created before visibility was turned off.
* If the sender becomes restricted, banned, or deleted before payment succeeds, the Pending Nakh cannot be delivered.
* If the receiver becomes restricted, banned, deleted, or profile-invalid before payment succeeds, the Pending Nakh cannot be delivered.

### Nakh

* id
* sender_user_id
* receiver_user_id
* text
* status
* sent_at
* seen_at
* accepted_at
* rejected_at
* closed_at
* expired_at
* created_at

Allowed statuses:

* sent
* seen
* accepted
* rejected
* closed
* expired

Rules:

* Nakh is created only after payment succeeds or credits are successfully spent.
* Sent Nakh appears in receiver’s Nakhes.
* Sent Nakh does not appear in receiver’s Liked By.
* Only one Nakh can be sent per sender/receiver pair.
* Nakh text maximum length: 240 characters.
* Nakh expires after 14 days.
* Rejected Nakh is shown in UI as Closed.

### NakhStatusHistory

* id
* nakh_id
* old_status
* new_status
* reason
* changed_at

Purpose:

* Tracks Nakh status changes over time.

### NakhReceiverAction

* id
* nakh_id
* receiver_user_id
* action_type
* created_at

Allowed action types:

* view_profile
* accept
* reject
* report

Rules:

* Viewing the profile can mark the Nakh as seen.
* Accepting a sent Nakh can create a Match.
* Rejecting closes the Nakh.
* Reporting starts the report flow.

## 7. Match and Chat Attributes

### Match

* id
* user_1_id
* user_2_id
* source
* status
* created_at
* unmatched_at
* closed_at

Allowed sources:

* mutual_like
* nakh_accept

Allowed statuses:

* active
* unmatched
* closed_by_admin

Rules:

* A Match connects exactly two users.
* After Match, users cannot Like, send Nakh, mark Not Interested, or appear to each other in Explore again.
* A Match creates one ChatSession.

### MatchParticipant

* id
* match_id
* user_id
* joined_at
* left_at

Purpose:

* Stores participant-level match data.

### UnmatchRecord

* id
* match_id
* unmatched_by_user_id
* other_user_id
* reason
* created_at
* report_window_expires_at

Rules:

* Unmatch closes the chat visually for both users.
* Unmatch prevents future matching between the same pair.
* Either user can report the other for 24 hours after unmatch.

### ChatSession

* id
* match_id
* status
* mode
* created_at
* closed_at
* closed_reason

Allowed statuses:

* active
* closed

Allowed modes:

* predefined_only
* unlocked_text

Allowed closed reasons:

* unmatch
* account_deleted
* admin_action
* user_banned

Rules:

* Chat exists only after Match.
* Free matched users start in predefined_only mode.
* If one side unlocks chat, the chat mode becomes unlocked_text for both users.

### ChatParticipant

* id
* chat_session_id
* user_id
* last_read_at
* muted_at
* joined_at

Purpose:

* Stores participant-level chat state.

### ChatMessage

* id
* chat_session_id
* sender_user_id
* message_type
* text
* predefined_question_id
* predefined_answer_id
* created_at
* deleted_at

Allowed message types:

* predefined_question
* predefined_answer
* text
* system

Rules:

* Before chat unlock, users can only send predefined questions and predefined answers.
* After chat unlock, users can send text messages only.
* Photos, stickers, media messages, and custom free text before unlock are not allowed.
* Only the last 50 visible messages per chat should remain available in normal chat view.
* Reported messages can be preserved separately through snapshots.

### ChatMessageSnapshot

* id
* report_id
* chat_session_id
* original_message_id
* sender_user_id
* message_type
* text
* created_at
* snapshotted_at

Purpose:

* Stores frozen moderation evidence for reported chats or messages.

### PredefinedQuestionSet

* id
* title
* topic
* is_active
* display_order
* created_at
* updated_at

Default topics:

* relationship_intent
* ideal_first_date
* chat_frequency
* introvert_extrovert
* weekend_habits
* calls_or_texting
* important_values
* meeting_in_person
* relationship_pace
* current_life_focus

### PredefinedQuestion

* id
* question_set_id
* text_key
* is_active
* display_order
* created_at
* updated_at

Note:

* The actual question text should come from localization through `text_key`.

### PredefinedAnswer

* id
* question_id
* text_key
* is_active
* display_order
* created_at
* updated_at

Note:

* The actual answer text should come from localization through `text_key`.

### ChatUnlock

* id
* match_id
* unlocked_by_user_id
* feature_unlock_id
* payment_id
* credit_transaction_id
* unlocked_at

Rule:

* One ChatUnlock is scoped to one Match.
* If one side unlocks chat, both users can send text in that Match.
* The other matched user does not need to pay again for the same Match.
* Chat unlock does not expire in MVP.

### ChatSafetyWarning

* id
* match_id
* user_id
* shown_at

Rule:

* Show the contact-sharing safety warning once when chat unlocks.

## 8. Payment Attributes

### CreditAccount

* id
* user_id
* balance
* created_at
* updated_at

Rule:

* One user has one credit account.

### CreditTransaction

* id
* credit_account_id
* user_id
* transaction_type
* amount
* balance_before
* balance_after
* related_payment_id
* related_feature_unlock_id
* related_nakh_id
* created_at

Allowed transaction types:

* purchase
* spend_nakh
* spend_chat_unlock
* spend_liked_by_unlock
* refund
* admin_adjustment

Rules:

* Every credit balance change must create a CreditTransaction.
* Spending credits must be transactional with the paid action.

### CreditPackage

* id
* title
* credit_amount
* stars_price
* discount_label
* is_active
* display_order
* created_at
* updated_at

Notes:

* Exact package sizes are not finalized.
* Exact discount rules are not finalized.

### PaymentRecord

* id
* user_id
* payment_type
* status
* amount_credits
* amount_stars
* provider
* provider_payment_id
* created_at
* paid_at
* failed_at
* cancelled_at
* refunded_at

Allowed payment types:

* buy_credit_package
* pay_pending_action
* direct_feature_payment

Allowed statuses:

* pending
* paid
* failed
* cancelled
* refunded
* expired

Allowed provider:

* telegram_stars

Rules:

* `provider_payment_id` must be unique when present.
* Duplicate provider callbacks must not double-process a payment.
* Paid actions can be funded by existing internal credits or by direct Telegram Stars payment.
* Both funding paths must result in the same final domain action.
* Direct Telegram Stars payment must not create different product behavior from credit-based payment.

### TelegramStarsPayment

* id
* payment_record_id
* telegram_charge_id
* telegram_payload
* stars_amount
* received_at
* raw_data

Purpose:

* Stores Telegram Stars-specific payment data.

### PaymentProviderEvent

* id
* provider
* event_type
* provider_event_id
* payment_record_id
* raw_payload
* received_at
* processed_at
* processing_status

Purpose:

* Stores raw provider events.
* Supports payment audit and idempotency.

### PendingPayment

* id
* user_id
* payment_reason
* target_type
* target_id
* required_credits
* status
* created_at
* expires_at
* paid_at
* cancelled_at

Allowed payment reasons:

* send_nakh
* unlock_chat
* unlock_liked_by_profile
* buy_credit_package

Allowed statuses:

* pending
* paid
* failed
* cancelled
* expired

Rules:

* Pending payments should expire.
* A PendingNakh may reference a PendingPayment.
* Pending payment completion must apply the related paid action exactly once.

### RefundRecord

* id
* payment_record_id
* credit_transaction_id
* user_id
* reason
* amount_credits
* amount_stars
* status
* created_at
* processed_at

Purpose:

* Tracks refunds or payment corrections.

## 9. Notification Attributes

### Notification

* id
* user_id
* notification_type
* title_key
* body_key
* payload
* status
* created_at
* read_at

Allowed statuses:

* unread
* read

Allowed notification types:

* like_received
* nakh_received
* match_created
* new_chat_message
* chat_unlocked
* liked_by_profile_unlocked
* report_result
* restriction_warning
* ban_warning
* payment_success
* payment_failure
* pending_nakh_payment_reminder
* admin_notice
* safety_notice

Rules:

* Normal Like creates a Liked By notification.
* Sent Nakh creates a Nakhes notification.
* Pending Nakh creates no receiver notification.
* Match creates notifications for both users.
* Payment, safety, admin, ban, and restriction notices cannot be muted.

### NotificationDelivery

* id
* notification_id
* user_id
* channel
* status
* sent_at
* failed_at
* failure_reason
* retry_count

Allowed channels:

* telegram
* in_app

Allowed statuses:

* pending
* sent
* failed

Purpose:

* Tracks notification delivery attempts and failures.

### NotificationPreference

* id
* user_id
* normal_notifications_muted
* chat_notifications_muted
* like_notifications_muted
* nakh_notifications_muted
* match_notifications_muted
* updated_at

Rules:

* Normal notifications can be muted.
* Safety notices cannot be muted.
* Payment notices cannot be muted.
* Admin notices cannot be muted.
* Ban notices cannot be muted.
* Restriction notices cannot be muted.

## 10. Moderation, Admin, and Support Attributes

### Report

* id
* reporter_user_id
* target_user_id
* reason_id
* extra_text
* status
* created_at
* reviewed_at
* closed_at

Allowed statuses:

* submitted
* pending_review
* dismissed
* actioned
* closed

Rules:

* Five unique reporters restrict the target until admin review.
* Reports do not automatically ban users.

### ReportReason

* id
* code
* label_key
* is_active
* display_order

Default reason codes:

* fake_profile
* harassment
* inappropriate_photo
* spam_or_scam
* under_18
* offensive_behavior
* other

### ReportEvidence

* id
* report_id
* evidence_type
* profile_id
* photo_id
* chat_session_id
* chat_message_id
* created_at

Allowed evidence types:

* profile
* photo
* chat
* message
* unmatched_user

### ReportSnapshot

* id
* report_id
* snapshot_type
* snapshot_data
* created_at

Purpose:

* Stores frozen reported context at report time.
* Prevents evidence loss after profile edits, photo changes, or chat cleanup.

### ModerationReview

* id
* report_id
* admin_user_id
* status
* decision_note
* started_at
* completed_at

Allowed statuses:

* pending
* in_review
* dismissed
* actioned

### ModerationAction

* id
* admin_user_id
* target_user_id
* report_id
* action_type
* reason
* created_at

Allowed action types:

* restrict_user
* unrestrict_user
* ban_user
* unban_user
* hide_photo
* restore_photo
* dismiss_report
* approve_change_request
* reject_change_request

### AdminUser

* id
* user_id
* telegram_user_id
* is_active
* created_at
* disabled_at

### AdminRole

* id
* name
* description
* is_active

Example roles:

* super_admin
* moderator
* support

### AdminPermission

* id
* code
* description

Example permissions:

* view_reports
* view_user_profile
* restrict_user
* unrestrict_user
* ban_user
* unban_user
* hide_photo
* restore_photo
* dismiss_report
* review_change_requests
* review_support
* review_appeals

### AdminUserRole

* id
* admin_user_id
* admin_role_id
* created_at

### AdminRolePermission

* id
* admin_role_id
* admin_permission_id
* created_at

### AdminActionLog

* id
* admin_user_id
* action_type
* target_user_id
* target_entity_type
* target_entity_id
* metadata
* created_at

Rule:

* Every admin action must be logged.

### SupportThread

* id
* user_id
* status
* created_at
* closed_at
* last_message_at

Allowed statuses:

* open
* reviewed
* closed

### SupportMessage

* id
* support_thread_id
* sender_user_id
* sender_admin_id
* message_text
* created_at

Rule:

* Support messages must be rate-limited.

### UserAppeal

* id
* user_id
* message_text
* status
* created_at
* reviewed_at
* reviewed_by_admin_id

Allowed statuses:

* submitted
* reviewed
* accepted
* rejected

Rule:

* Banned users can send one limited appeal/support message.

## 11. Localization, Jobs, Audit, and Config Attributes

### Locale

* id
* code
* name
* is_active
* is_default
* created_at
* updated_at

MVP locale:

* en

Future locale:

* fa

### UIText

* id
* locale_id
* text_key
* text_value
* category
* is_active
* created_at
* updated_at

Allowed categories:

* button
* message
* error
* admin
* payment
* notification
* safety

Rule:

* User-facing bot text should not be hardcoded inside handlers.

### ScheduledJob

* id
* job_name
* job_type
* is_active
* schedule_config
* last_run_at
* next_run_at
* created_at
* updated_at

Allowed job types:

* expire_nakh
* expire_pending_payment
* send_pending_payment_reminder
* cleanup_chat_messages
* notification_retry

### JobRunLog

* id
* scheduled_job_id
* status
* started_at
* finished_at
* error_message
* metadata

Allowed statuses:

* started
* success
* failed
* skipped

### AuditLog

* id
* actor_user_id
* actor_admin_id
* event_type
* entity_type
* entity_id
* metadata
* created_at

Purpose:

* Tracks important system events.

### PaymentAuditLog

* id
* user_id
* payment_record_id
* event_type
* metadata
* created_at

Purpose:

* Tracks payment-specific events.

### SafetyAuditLog

* id
* user_id
* related_report_id
* event_type
* metadata
* created_at

Purpose:

* Tracks safety and moderation events.

### DataRetentionRecord

* id
* user_id
* deletion_record_id
* retained_data_type
* reason
* created_at

Purpose:

* Tracks minimal retained data after account deletion.

### RateLimitRecord

* id
* user_id
* action_type
* window_start_at
* action_count
* blocked_until

Rate-limited actions:

* support_message
* report_submit
* photo_upload
* payment_attempt
* admin_appeal

### SystemConfig

* id
* config_key
* config_value
* updated_at
* updated_by_admin_id

Config examples:

* guest_preview_limit
* min_signup_age
* min_profile_photos
* max_profile_photos
* min_interests
* max_interests
* highlight_max_length
* bio_max_length
* nakh_text_max_length
* nakh_expiry_days
* liked_by_unlock_cost
* chat_unlock_cost
* nakh_cost

## 12. Notes

* These are domain attributes, not final database columns.
* Database-specific types, indexes, constraints, and foreign keys will be defined later.
* Product constants should be stored in `SystemConfig` or code-level config, not scattered through handlers.
* Notification settings belong to `NotificationPreference`, not `UserSettings`.
* `UserPairState` is a summary record and does not replace source records.
* `PendingNakh` and `Nakh` are separate because unpaid Nakh and paid sent Nakh have different product meanings.
* `FeatureUnlock` handles scoped unlocks. There is no separate `LikedByUnlock` entity.



