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

Rules:

* `reactivation_allowed` controls whether the deleted account may be reactivated.
* Reactivation reuses the same `user_id`.
* Reactivation must not create a clean new User for the same Telegram identity.
* Retained report, moderation, payment, safety, and audit records remain attached to the same `user_id`.

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
* The counter applies to Guest Preview, not normal Explore.
* Guest Preview is available only while the account state is `guest` or `incomplete`.
* Guest Preview uses the Guest Preview Pool and does not use normal Explore filters.

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
* MVP age eligibility is approximate because exact birth date is not collected.
* Eligibility rule: `birth_year <= current_gregorian_year - 18`.
* The system cannot verify whether the user has already had their 18th birthday in the current year.
* Age verification is not included in MVP.
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
* `completion_status = invalid` does not change `Account.state` back to `incomplete`.
* A user can have `Account.state = active` and `Profile.completion_status = invalid`.
* This combination routes the user to Fix Profile.
* Invalid active profile users cannot Explore, appear in Explore, Like, send Nakh, or create new discovery interactions.
* When required profile completion rules are satisfied again, `completion_status` should be set back to `complete`.


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

Rules:

* Represents a spoken language selectable on a dating profile.
* Does not represent bot UI language.
* MVP should include English as an available spoken language.
* Additional spoken languages can be added later by adding Language records.
* Spoken languages must not be stored as free text.

### ProfileLanguage

* id
* profile_id
* language_id
* created_at

Rules:

* Connects a profile to a spoken language.
* Spoken languages belong to the dating profile, not directly to the user account.

### PersonalityTag

* id
* name
* is_active
* display_order

Rules:

* Represents a selectable personality tag shown on dating profiles.
* Personality tags should be data-driven and should not be hardcoded inside bot handlers.

### ProfilePersonalityTag

* id
* profile_id
* personality_tag_id
* created_at

Rules:

* Connects a profile to a selected personality tag.
* Personality tags belong to the dating profile, not directly to the user account.

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
* * User-deleted profile-photo media objects must be permanently deleted from object storage/CDN.
* Deleted media may be retained only when required for an active report, moderation case, safety case, legal/audit case, or immutable report snapshot.
* Retained evidence media must not remain available through normal user-facing profile URLs.

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

* Minimum visible profile photos for completion: 2.
* Maximum saved profile photos per profile: 6.
* Saved profile photos means profile photos currently stored as visible or hidden.
* Hidden photos count toward the 6-photo saved-photo limit, but do not count toward profile completion.
* Only visible photos count toward the 2-photo completion requirement.
* Deleted photos are removed from the profile and their stored media objects must be permanently deleted from object storage/CDN.
* A deleted photo no longer counts as a saved profile photo after its stored media object is deleted.
* Extra saved profile photos are rejected.
* One visible photo must always be primary.
* User cannot delete the primary photo before choosing another visible primary photo.
* If admin hides or deletes the primary photo, another visible photo should become primary if available.
* If no visible primary photo can be assigned, profile validity must be rechecked.
* If a deleted photo is linked to an active report, moderation case, safety case, legal/audit case, or immutable report snapshot, the user-facing photo is removed immediately, but the evidence copy may be retained in restricted moderation/audit storage until retention rules allow deletion.

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

Rules:

* `hidden` means the photo was removed from user-visible profile surfaces but remains restorable.
* `restored` means a hidden photo was made visible again.
* `deleted` means the photo was soft-deleted from the dating profile.
* Admin photo deletion must not immediately hard-delete the underlying media asset.
* Deleted photo records and media metadata may be retained for audit, moderation, reports, appeals, abuse prevention, and safety history.

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
* For MVP, Country is fixed to Iran and is not shown as a user-facing Explore filter.
* Province is used only to group/select cities.
* MVP Explore location filtering is city-level.
* Province-wide browsing is not included in MVP.
* Whole-country browsing is not included in MVP.
* `country_id` and `province_id` are kept for structure and future extensibility.

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

Guest Preview rule:

* Guest and incomplete profile previews also create `ExploreConsumption` with reason `preview`.
* Guest Preview consumption is permanent.
* Guest Preview consumption does not require normal Explore filters or reciprocal gender compatibility.

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
* matched
* unmatched
* blocked

Rules:

* Use normalized pair ordering: `user_a_id < user_b_id`.
* UserPairState is a symmetric pair-level summary only.
* UserPairState must not store directional states.

Directional actions must be read from source records:

* ExploreConsumption
* Like
* NotInterested
* PendingNakh
* Nakh

Notes:

* `UserPairState` does not replace `Like`, `NotInterested`, `PendingNakh`, `Nakh`, `Match`, or `UnmatchRecord`.
* `UserPairState` should only be used to quickly block pair-level actions after match, unmatch, or block.

### FeatureUnlock

* id
* payer_user_id
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
* For `chat_unlock`, `match_id` must be set and `target_user_id` must be empty.
* For `liked_by_profile_unlock`, `target_user_id` must be set and `match_id` must be empty.
* `user_id` is the user who paid for or triggered the unlock.
* `payment_id` stores the direct Telegram Stars payment when the unlock was funded directly.
* `credit_transaction_id` stores the credit spend transaction when the unlock was funded with existing credits.
* ChatUnlock must not duplicate `payment_id`, `credit_transaction_id`, `status`, `expires_at`, or `revoked_at`.

Ownership rules:

* `payer_user_id` is always the user who paid for the unlock.
* `payer_user_id` does not define who receives access.
* Access scope is defined by `feature_type` plus the scoped target fields.
* For `liked_by_profile_unlock`, access is scoped to one liked-by profile/pair through `target_user_id`.
* For `chat_unlock`, access is scoped to one Match through `match_id`.
* For `chat_unlock`, both users in the Match receive unlocked text-chat access, even though only one user paid.
* Chat access checks must use `match_id` / ChatUnlock state, not `payer_user_id`.

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
* Creating a Pending Nakh consumes the sender’s single allowed Nakh flow for that receiver.
* A sender/receiver pair can have only one Nakh flow ever.
* A Nakh flow may be represented first by PendingNakh and then by Nakh after successful payment.
* If PendingNakh becomes expired, abandoned, cancelled, or payment failed/cancelled, the sender still cannot create another PendingNakh or Nakh for the same receiver.
* Pending Nakh text can be edited before payment.
* Pending Nakh expires if it is not paid within the configured expiry duration.
* Exact Pending Nakh expiry duration is configurable and must not be hardcoded in handlers.
* If cancelled before payment, the sender must choose whether to convert it to a normal Like or mark the target as Not Interested.
* A visibility-off sender cannot create a new Pending Nakh.
* A visibility-off sender may complete payment for a Pending Nakh created before sender visibility was turned off.
* A visibility-off receiver may still receive a Sent Nakh if the Pending Nakh was created before receiver visibility was turned off.
* Receiver visibility off blocks new discovery only. It does not block delivery of an already-created Pending Nakh after payment succeeds.
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
* Only one Nakh flow is allowed per sender/receiver pair.
* A Nakh record must not be created if the same sender/receiver pair already has any PendingNakh or Nakh flow.
* A Nakh record may be created from an existing PendingNakh only when payment succeeds or credits are successfully spent.
* Nakh text maximum length: 240 characters.
* Nakh expires after 14 days.
* Receiver rejection must set `status = rejected`.
* Rejected Nakh is shown in UI as Closed.
* `status = closed` is reserved for generic non-rejection closure cases, such as admin/moderation/system closure.
* `rejected_at` is used only when the receiver rejects the Nakh.
* `closed_at` is used only when the Nakh enters `status = closed`.

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
* Rejecting sets `Nakh.status = rejected` and `Nakh.rejected_at`.
* Rejecting does not set `Nakh.status = closed`.
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
* feature_unlock_id
* unlocked_at
* unlocked_by_user_id

Rule:

* One ChatUnlock is scoped to one Match.
* One ChatUnlock belongs to one FeatureUnlock.
* ChatUnlock is a chat-domain marker only.
* ChatUnlock does not store payment, credit, status, expiry, or revocation fields.
* FeatureUnlock is the source of truth for payment funding, unlock status, expiry, and revocation.
* The user who paid for the unlock is stored on FeatureUnlock.user_id.
* If one side unlocks chat, both users can send text in that Match.
* The other matched user does not need to pay again for the same Match.
* Chat unlock does not expire in MVP.
* `unlocked_by_user_id` must be the same user as `FeatureUnlock.payer_user_id`.

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
* paid_action_reason
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
* direct_paid_action
* pay_pending_action

Allowed paid action reasons:

* send_nakh
* unlock_chat
* unlock_liked_by_profile

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

Rules:

* `provider_payment_id` must be unique when present.
* Duplicate provider callbacks must not double-process a payment.
* Paid actions can be funded by existing internal credits or by direct Telegram Stars payment.
* Both funding paths must result in the same final domain action.
* Direct Telegram Stars payment must not create different product behavior from credit-based payment.
* `payment_type` describes how the Telegram Stars payment is used.
* `paid_action_reason` describes the one-off paid action, when the payment is for a paid action.
* For `payment_type = buy_credit_package`, `paid_action_reason` must be empty/null.
* For `payment_type = direct_paid_action`, `paid_action_reason` must be one of `send_nakh`, `unlock_chat`, or `unlock_liked_by_profile`.
* For `payment_type = pay_pending_action`, the paid action is resolved from the related PendingPayment.
* `amount_stars` stores the Telegram Stars amount charged.
* `amount_credits` stores the number of internal credits purchased or spent, when applicable.
* Direct paid actions may have `amount_stars` without adding credits to the user balance.

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
* PendingPayment is used when payment cannot be completed immediately or when a paid action is waiting for Telegram Stars confirmation.
* PendingPayment may be used for `send_nakh`, `unlock_chat`, `unlock_liked_by_profile`, or `buy_credit_package`.
* For `send_nakh`, successful PendingPayment completion delivers the related Nakh.
* For `unlock_chat`, successful PendingPayment completion creates the chat unlock.
* For `unlock_liked_by_profile`, successful PendingPayment completion creates the liked-by profile unlock.
* For `buy_credit_package`, successful PendingPayment completion adds credits to the user credit balance.

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
* delete_photo
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
* delete_photo
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
* value_type
* description
* is_active
* updated_at
* updated_by_admin_id

Purpose:

* Stores tunable MVP product constants.
* Prevents product values from being hardcoded inside handlers, payment code, background jobs, or feature services.
* Does not replace enums.
* Does not store user-facing text. User-facing text belongs to UIText.
* Does not store seed data lists such as interests, provinces, cities, predefined questions, or predefined answers.

Required MVP config keys:

Access and signup:

* guest_preview_limit
* min_signup_age
* name_max_length
* change_request_reason_max_length

Profile completion:

* min_profile_photos
* max_profile_photos
* min_interests
* max_interests
* highlight_max_length
* bio_max_length

Nakh:

* nakh_text_max_length
* nakh_cost
* nakh_expiry_days
* pending_nakh_expiry_minutes
* pending_nakh_reminder_schedule

Liked By:

* liked_by_unlock_cost
* liked_by_unlock_expiry_hours

Chat:

* chat_unlock_cost

Payments and credits:

* credit_package_options
* telegram_stars_pricing
* refund_policy

Media:

* media_storage_provider
* media_cdn_provider
* max_photo_file_size_mb
* allowed_photo_mime_types

Admin bootstrap:

* bootstrap_admin_telegram_ids

Rules:

* Paid-action costs must be read from SystemConfig or code-level configuration.
* Expiry durations must be read from SystemConfig or code-level configuration.
* Background job schedules that are product-tunable must be read from SystemConfig or code-level configuration.
* Payment/refund policy values must be read from SystemConfig or code-level configuration.
* Handler code must not contain hardcoded product constants except for safe technical defaults.

## 12. Notes

* These are domain attributes, not final database columns.
* Database-specific types, indexes, constraints, and foreign keys will be defined later.
* Product constants should be stored in `SystemConfig` or code-level config, not scattered through handlers.
* Notification settings belong to `NotificationPreference`, not `UserSettings`.
* `UserPairState` is a summary record and does not replace source records.
* `PendingNakh` and `Nakh` are separate because unpaid Nakh and paid sent Nakh have different product meanings.
* `FeatureUnlock` handles scoped unlocks. There is no separate `LikedByUnlock` entity.



