# Statuses and Enums

This file lists controlled values used in the Telegram Dating Bot MVP.

These values should not be random strings scattered across the codebase.

## 1. Account, Signup, Profile, Media, Explore, and Interaction Enums

### AccountState

* guest
* incomplete
* active
* restricted
* banned
* deleted

### SignupStep

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

### Gender

MVP values:

* man
* woman
* other
* prefer_not_to_say

Notes:

* These are the MVP-supported gender values.
* Gender handling must remain extensible because additional gender options may be added later.
* Implementation should not assume that gender will always be limited to only these four values.

### InterestedGender

* men
* women
* everyone

Note:

* Interested gender is stored as one profile-level field.
* Changing it from Explore or Edit Profile updates the same value.

### RelationshipGoal

* serious_relationship
* casual_dating
* friendship
* marriage
* not_sure_yet

### ProfileCompletionStatus

* incomplete
* complete
* invalid

Notes:

* `incomplete` means the profile has not completed all required signup/profile fields.
* `complete` means the profile currently satisfies all required profile completion rules.
* `invalid` means the profile was previously complete but no longer satisfies validity rules, for example because moderation hid photos and fewer than 2 visible photos remain.
* Profile completion status is the source of truth for profile validity. A boolean `is_completed` should only be derived from this status if needed.

### VisibilityStatus

* visible
* hidden

### PhotoStatus

* visible
* hidden
* deleted

### PhotoVariantType

* thumbnail
* blurred_preview

### PhotoModerationActionType

* hidden
* restored
* deleted

### ExploreConsumptionReason

* preview
* like
* not_interested
* pending_nakh
* sent_nakh
* match

### ExploreEmptyState

* nobody_found

### LikeStatus

* active
* cancelled
* closed_by_match
* closed_by_unmatch

### NotInterestedSource

* explore
* liked_by
* cancelled_pending_nakh
* unmatch

### UserPairState

* none
* viewed
* liked
* not_interested
* pending_nakh
* nakh_sent
* matched
* unmatched
* blocked

## 2. Nakh, Match, Chat, Payment, and Feature Unlock Enums

### PendingNakhStatus

* pending_payment
* paid_and_sent
* cancelled
* expired
* abandoned

### PendingNakhCancelResolution

* converted_to_like
* converted_to_not_interested
* abandoned

### NakhStatus

* sent
* seen
* accepted
* rejected
* closed
* expired

Note:

* Rejected Nakh is shown in UI as Closed.

### NakhReceiverActionType

* view_profile
* accept
* reject
* report

### MatchSource

* mutual_like
* nakh_accept
* nakh_like_back

### MatchStatus

* active
* unmatched
* closed_by_admin

### ChatStatus

* active
* closed

### ChatMode

* predefined_only
* unlocked_text

### ChatMessageType

* predefined_question
* predefined_answer
* text
* system

### ChatClosedReason

* unmatch
* account_deleted
* admin_action
* user_banned

### PaymentStatus

* pending
* paid
* failed
* cancelled
* refunded
* expired

### PaymentProvider

* telegram_stars

### PaymentType

* buy_credit_package
* pay_pending_action
* direct_feature_payment

### PendingPaymentStatus

* pending
* paid
* failed
* cancelled
* expired

### PendingPaymentReason

* send_nakh
* unlock_chat
* unlock_liked_by_profile
* buy_credit_package

### CreditTransactionType

* purchase
* spend_nakh
* spend_chat_unlock
* spend_liked_by_unlock
* refund
* admin_adjustment

### FeatureUnlockType

* liked_by_profile_unlock
* chat_unlock

### FeatureUnlockStatus

* active
* expired
* revoked

## 3. Notification Enums

### NotificationType

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

### NotificationStatus

* unread
* read

### NotificationDeliveryChannel

* telegram
* in_app

### NotificationDeliveryStatus

* pending
* sent
* failed

### NotificationMuteCategory

* normal
* chat
* like
* nakh
* match

Non-mutable notification categories:

* safety
* payment
* admin
* ban
* restriction

## 4. Moderation, Admin, Support, and Appeal Enums

### ReportStatus

* submitted
* pending_review
* dismissed
* actioned
* closed

### ReportReasonCode

* fake_profile
* harassment
* inappropriate_photo
* spam_or_scam
* under_18
* offensive_behavior
* other

### ReportEvidenceType

* profile
* photo
* chat
* message
* unmatched_user

### ModerationReviewStatus

* pending
* in_review
* dismissed
* actioned

### ModerationActionType

* restrict_user
* unrestrict_user
* ban_user
* unban_user
* hide_photo
* restore_photo
* dismiss_report
* approve_change_request
* reject_change_request

### AdminRoleCode

* super_admin
* moderator
* support

### AdminPermissionCode

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

### SupportThreadStatus

* open
* reviewed
* closed

### UserAppealStatus

* submitted
* reviewed
* accepted
* rejected

### ProfileChangeRequestStatus

* pending
* approved
* rejected
* cancelled

## 5. Jobs, Localization, and Audit Enums

### JobRunStatus

* started
* success
* failed
* skipped

### ScheduledJobType

* expire_nakh
* expire_pending_payment
* send_pending_payment_reminder
* cleanup_chat_messages
* notification_retry

### LocaleCode

* en
* fa

MVP locale:

* en

Future locale:

* fa

### UITextCategory

* button
* message
* error
* admin
* payment
* notification
* safety

### AuditActorType

* user
* admin
* system

### AuditEventType

* account_state_changed
* profile_updated
* profile_deleted
* payment_created
* payment_paid
* payment_failed
* credit_spent
* feature_unlocked
* report_submitted
* user_restricted
* user_banned
* photo_hidden
* chat_closed
* admin_action

## 6. Notes

* Enum values should be stable and lowercase.
* User-facing labels should come from localization, not enum names.
* Product constants should go in `SystemConfig`, not enums.
* Enums should not be expanded casually; each new value may affect permissions, transitions, filters, or reporting.
* Pending Nakh and Sent Nakh use separate status groups because they have different product meaning.
* Rejected Nakh can be stored internally as `rejected`, but the UI should show it as Closed.
* `UserPairState` is a summary state and does not replace source records.










