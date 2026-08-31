# Statuses, Enums, and Transitions

This document is the canonical registry for stable internal codes and legal transitions. User-facing labels always come from localization.

## 1. Account and signup

### AccountState

- `guest`
- `incomplete`
- `active`
- `restricted`
- `banned`
- `deleted`

Legal transitions:

| From | To | Trigger |
|---|---|---|
| none | guest | First known Telegram start |
| guest | incomplete | Signup starts |
| guest | restricted, banned, deleted | Safety/admin action or deletion |
| incomplete | active | Profile confirmation succeeds |
| incomplete | restricted, banned, deleted | Safety/admin action or deletion |
| active | restricted, banned, deleted | Moderation/admin action or deletion |
| restricted | guest, incomplete, active | Restriction removed to the latest valid pre-restriction state |
| restricted | banned, deleted | Admin action or deletion |
| banned | guest, incomplete, active, restricted | Admin accepts appeal or unbans to the latest valid pre-ban state |
| banned | deleted | Account deletion handled under retained ban policy |
| deleted | guest | Fresh return is explicitly allowed after safety resolution |

No other transition is legal. Profile invalidity never changes Account state.

### SignupStep

- `age_confirmation`
- `name`
- `birth_year`
- `gender`
- `relationship_gender_preference`
- `interests`
- `location`
- `relationship_goal`
- `primary_photo`
- `additional_photos`
- `highlight`
- `optional_details`
- `confirm_profile`
- `completed`

## 2. Profile catalogs and states

### GenderOption seed codes

- `man`
- `woman`
- `other`

These are data rows, not a closed database enum.

### GenderPreference seed codes and members

| Preference | GenderOption members |
|---|---|
| `men` | man |
| `women` | woman |
| `everyone` | man, woman, other |

These are data rows and mappings, not hardcoded branching logic.

### RelationshipGoal

- `serious_relationship`
- `casual_dating`
- `friendship`
- `marriage`
- `not_sure_yet`

### ProfileCompletionStatus

- `incomplete`
- `complete`
- `invalid`

Transitions:

- incomplete -> complete when confirmation satisfies every requirement.
- complete -> invalid when a later change breaks a requirement.
- invalid -> complete when all requirements are restored.
- complete never returns to incomplete; `ever_completed` determines invalidation.

### Optional Profile enums

EducationLevel:

- `high_school_or_less`
- `vocational`
- `associate`
- `bachelor`
- `master`
- `doctorate`
- `other`

SmokingPreference:

- `never`
- `occasionally`
- `regularly`
- `trying_to_quit`

PetsPreference:

- `have_pets`
- `want_pets`
- `like_pets`
- `no_pets`
- `allergic`

ExerciseFrequency:

- `never`
- `occasionally`
- `weekly`
- `frequently`
- `daily`

ReligionImportance:

- `not_important`
- `somewhat_important`
- `very_important`

ChildrenPreference:

- `want_children`
- `do_not_want_children`
- `have_and_want_more`
- `have_and_do_not_want_more`
- `not_sure`

All are nullable and do not affect Profile completion.

## 3. Media

### MediaValidationStatus

- `pending`
- `valid`
- `rejected`
- `failed`

Terminal statuses are valid, rejected, and failed.

### PhotoStatus

- `visible`
- `hidden`
- `deleted`

Transitions:

- Processing success creates visible.
- Admin hide: visible -> hidden.
- Admin restore: hidden -> visible.
- User or admin delete: visible/hidden -> deleted.
- Deleted is terminal.

`hidden` is not user-selectable.

### PhotoVariantType

- `thumbnail`
- `blurred_preview`

### PhotoModerationActionType

- `hide`
- `restore`
- `delete`

## 4. Explore and interactions

### ExploreConsumptionReason

- `preview`
- `like`
- `not_interested`
- `nakh_flow`
- `match`

One viewer/target record exists, and reason records the first event that consumed the target. It is immutable.

### LikeStatus

- `active`
- `closed_by_match`
- `closed_by_not_interested`
- `closed_by_unmatch`
- `cancelled_by_system`

Normal users cannot produce `cancelled_by_system`. All non-active statuses are terminal except that closed_by_match may become closed_by_unmatch when its Match is later unmatched.

### NotInterestedSource

- `explore`
- `liked_by`
- `cancelled_pending_nakh`

Unmatch is not a NotInterested source.

### UserPairState

- `matched`
- `unmatched`
- `blocked`

Absence of a row means none. State transitions are matched -> unmatched, or any state/absence -> blocked. Blocked is terminal unless a specific admin safety reversal restores absence; it never automatically restores an old Match.

### FeatureUnlockType

- `liked_by_profile_unlock`
- `chat_unlock`

### FeatureUnlockStatus

- `active`
- `revoked`
- `expired` — reserved for a future time-limited product; not produced by MVP

MVP transition is active -> revoked. Effective access also ends when the scoped Like stops being actionable or the scoped Match closes.

## 5. Nakh

### PendingNakhStatus

- `pending_payment`
- `paid_and_sent`
- `cancelled`
- `expired`
- `closed_by_system`

Only pending_payment is non-terminal and counts toward the sender-wide limit.

Legal transitions:

- pending_payment -> paid_and_sent after one atomic delivery.
- pending_payment -> cancelled after the sender chooses a resolution.
- pending_payment -> expired at the deadline.
- pending_payment -> closed_by_system when current non-visibility eligibility prevents delivery.

### PendingNakhCancelResolution

- `converted_to_like`
- `converted_to_not_interested`

The value is required only for status cancelled.

### NakhStatus

- `sent`
- `seen`
- `accepted`
- `rejected`
- `expired`
- `closed`

Legal transitions:

- sent -> seen, accepted, rejected, expired, closed
- seen -> accepted, rejected, expired, closed
- accepted, rejected, expired, and closed are terminal

`rejected` is a receiver decision and is displayed as “Closed.” `closed` is reserved for admin/system closure. Pending payment is never a NakhStatus.

### NakhReceiverActionType

- `view_profile`
- `accept`
- `reject`
- `report`

## 6. Match and chat

### MatchSource

- `mutual_like`
- `nakh_accept`

### MatchStatus

- `active`
- `unmatched`
- `closed`

Active -> unmatched is a user action. Active -> closed is a system/admin lifecycle action. Terminal Matches never reactivate.

### ChatStatus

- `active`
- `closed`

### ChatMessageType

- `predefined_question`
- `predefined_answer`
- `text`
- `system`

### ChatClosedReason

- `unmatch`
- `account_deleted`
- `user_banned`
- `admin_action`
- `internal_block`

## 7. Payments and credits

### PaymentProvider

- `telegram_stars`

### PaymentType

- `buy_credit_package`
- `direct_paid_action`
- `pay_pending_action`

### PaidActionReason

- `send_nakh`
- `unlock_chat`
- `unlock_liked_by_profile`

### PendingPaymentReason

- `send_nakh`
- `unlock_chat`
- `unlock_liked_by_profile`
- `buy_credit_package`

### PendingPaymentStatus

- `pending`
- `paid`
- `failed`
- `cancelled`
- `expired`

Only pending is non-terminal. A new provider attempt may be attached after a failed PaymentRecord while the product-level PendingPayment remains pending.

### PaymentStatus

- `pending`
- `paid`
- `failed`
- `cancelled`
- `expired`
- `refunded`

Paid -> refunded is allowed only through an idempotent system-fault correction.

### PaymentProviderEventProcessingStatus

- `received`
- `processed`
- `ignored_duplicate`
- `failed_retryable`
- `failed_terminal`

### CreditTransactionType

- `purchase`
- `spend_nakh`
- `spend_chat_unlock`
- `spend_liked_by_unlock`
- `refund`
- `admin_adjustment`

### RefundStatus

- `pending`
- `processed`
- `failed_retryable`
- `failed_terminal`

## 8. Notifications

### NotificationType

- `like_received`
- `nakh_received`
- `match_created`
- `new_chat_message`
- `chat_unlocked`
- `liked_by_profile_unlocked`
- `report_result`
- `restriction_warning`
- `ban_warning`
- `payment_success`
- `payment_failure`
- `pending_nakh_payment_reminder`
- `admin_notice`
- `safety_notice`
- `chat_closed`

### NotificationStatus

- `unread`
- `read`

### NotificationDeliveryChannel

- `telegram`
- `in_app`

### NotificationDeliveryStatus

- `pending`
- `sent`
- `failed_retryable`
- `failed_terminal`

Mutable categories are chat, like, nakh, and match. Safety, payment, admin, ban, and restriction notifications cannot be muted.

## 9. Moderation, admin, support, and appeal

### ReportStatus

- `submitted`
- `pending_review`
- `dismissed`
- `actioned`
- `closed`

Submitted and pending_review are unresolved.

### ReportReasonCode

- `fake_profile`
- `harassment`
- `inappropriate_photo`
- `spam_or_scam`
- `under_18`
- `offensive_behavior`
- `other`

### ReportEvidenceType

- `profile`
- `photo`
- `chat`
- `message`
- `unmatched_user`

### ModerationReviewStatus

- `pending`
- `in_review`
- `dismissed`
- `actioned`

### ModerationActionType

- `restrict_user`
- `unrestrict_user`
- `ban_user`
- `unban_user`
- `hide_photo`
- `restore_photo`
- `delete_photo`
- `dismiss_report`
- `internal_block_pair`
- `remove_internal_block`
- `approve_change_request`
- `reject_change_request`

### Admin role seed codes

- `super_admin`
- `moderator`
- `support`

### Admin permission seed codes

- `view_reports`
- `view_user_profile`
- `restrict_user`
- `unrestrict_user`
- `ban_user`
- `unban_user`
- `hide_photo`
- `restore_photo`
- `delete_photo`
- `dismiss_report`
- `manage_internal_blocks`
- `review_change_requests`
- `review_support`
- `review_appeals`

### ProfileChangeRequestStatus

- `pending`
- `approved`
- `rejected`
- `cancelled`

### ProfileChangeDecision

- `approved`
- `rejected`

### SupportThreadStatus

- `open`
- `in_review`
- `closed`

### UserAppealStatus

- `submitted`
- `in_review`
- `accepted`
- `rejected`

## 10. Localization, jobs, rate limits, and audit

### Locale seed codes

- `en` — active default MVP locale
- `fa` — reserved future locale

### UITextCategory

- `button`
- `message`
- `error`
- `admin`
- `payment`
- `notification`
- `safety`

### ScheduledJobType

- `expire_pending_nakh`
- `expire_sent_nakh`
- `send_pending_nakh_reminder`
- `cleanup_chat_messages`
- `retry_notification_delivery`
- `refresh_explore_shuffle_keys`
- `cleanup_media`

### JobRunStatus

- `started`
- `succeeded`
- `failed`
- `skipped`

### RateLimitActionType

- `support_message`
- `report_submit`
- `photo_upload`
- `payment_attempt`
- `ban_appeal`

### AuditActorType

- `user`
- `admin`
- `system`

### AdminActionResult

- `succeeded`
- `rejected`
- `failed`

## 11. Registry rules

- Codes are lowercase snake_case and stable after release.
- Renaming a user-facing label never changes a code.
- New GenderOptions or GenderPreferences are added through catalog data and mappings.
- New enum values require permission, transition, analytics, localization, migration, and backward-compatibility review.
- Product constants belong to SystemConfig/code configuration, not this registry.
