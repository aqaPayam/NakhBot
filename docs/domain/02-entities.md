# Domain Entities

This file lists the domain entities used in the Telegram Dating Bot MVP.

These are domain entities, not final database tables. Database schema design comes later.

## 1. Entity Categories

Entities are grouped into these categories:

* Core Entities
* Supporting Entities
* Profile Option Entities
* Optional / Later Entities
* Removed / Rejected Entities

## 2. Core Entities

Core entities are required for the MVP.

### 2.1 Identity and Account

#### User

Main internal system identity for a Telegram person.

#### TelegramIdentity

External Telegram identity attached to a user.

Stores Telegram-specific identity data.

#### Account

User access and lifecycle state.

Controls guest, incomplete, active, restricted, banned, and deleted states.

#### AccountStateHistory

History of account state changes.

Used for restriction, ban, deletion, reactivation, and admin traceability.

#### AccountDeletionRecord

Separate record for account deletion.

Tracks deletion time, profile hiding, chat closure, and reactivation eligibility.

#### GuestPreviewCounter

Permanent preview counter for guest and incomplete users.

The counter is shared by Telegram identity/user and does not reset during incomplete signup.

#### UserSettings

General user settings.

Owns visibility and language preference.

#### UserBlock

Internal safety record used to prevent future interaction between users when needed.

Can support moderation, rejection, or safety flows.

### 2.2 Signup

#### SignupProgress

Tracks the user’s current signup step.

Used until profile completion.

#### SignupDraft

Stores temporary signup answers before final profile completion.

### 2.3 Profile

#### Profile

Dating-visible user information.

Owns profile data such as name, Gregorian birth year, gender, interested gender, relationship goal, location, highlight, bio, and completion status.

Age is derived from Gregorian birth year and is not stored as a separate source-of-truth field.

Profile completion status can be incomplete, complete, or invalid.

#### ProfileOptionalDetails

Optional profile information.

Includes optional data such as height, job title, education, smoking preference, pets, exercise/gym, religion importance, and children preference.

#### Interest

Selectable interest item.

#### ProfileInterest

Connection between a profile and selected interests.

Interests belong to the dating profile, not directly to the user.

#### ProfileChangeRequest

Request to change locked profile fields.

Allowed locked fields are birth year and gender.

#### ProfileChangeReview

Admin review result for a profile change request.

#### Language

Selectable spoken language option for profile details.

#### ProfileLanguage

Connection between a profile and spoken languages.

Spoken languages belong to the dating profile, not directly to the user.

#### PersonalityTag

Selectable personality tag.

#### ProfilePersonalityTag

Connection between a profile and selected personality tags.

Personality tags belong to the dating profile, not directly to the user.

### 2.4 Location

#### Country

Top-level location entity.

MVP supports Iran only.

#### Province

Province/state under a country.

#### City

City under a province.

Cities are selected from a fixed list. There is no free-text city and no “Other” city option in MVP.

### 2.5 Media

#### MediaAsset

Stored uploaded file metadata.

Represents the original uploaded file stored in object storage and served through CDN.

#### ProfilePhoto

Photo attached to a dating profile.

Controls primary photo status, display order, and photo visibility.

#### PhotoVariant

Generated version of a media asset.

Examples:

* Thumbnail
* Blurred preview

#### PhotoModerationRecord

Record of moderation actions on a profile photo.

Used when a photo is hidden, restored, or deleted.

### 2.6 Explore

#### ExploreFilter

Stored Explore filter values for a user.

Includes age range, location, and relationship goal.

Interested gender is stored on Profile, not here.

#### ExploreConsumption

Permanent record that a viewer has already seen or acted on a target profile.

Consumed profiles must not be shown again.

#### ExploreSession

Optional browsing session record.

Useful for analytics, debugging, and abuse detection. Not required for the first implementation.

### 2.7 Interaction

#### Like

Free weak signal from one user to another.

A normal Like appears in the receiver’s Liked By section.

#### NotInterested

Permanent negative action from one user toward another.

Used when a user rejects a profile from Explore, Liked By, cancelled Pending Nakh, or unmatch flow.

#### UserPairState

Current summarized state between two users.

Used to prevent invalid actions such as sending Nakh after Match.

#### FeatureUnlock

Paid unlock record for a scoped feature.

Used for:

* Liked By profile unlock
* Chat unlock

Feature unlocks can expire or be revoked depending on feature type and configuration.

Nakh is not modeled as a FeatureUnlock. Nakh is a paid action, not persistent feature access.

### 2.8 Nakh

#### PendingNakh

Unpaid Nakh attempt.

Visible only to the sender.

Does not notify the receiver, does not create Like, does not appear in Liked By, and does not create Match.

#### Nakh

Paid strong signal sent from one user to another.

A sent Nakh appears in receiver’s Nakhes, not in Liked By.

#### NakhStatusHistory

History of Nakh status changes.

#### NakhReceiverAction

Receiver action on a sent Nakh.

Examples:

* View profile
* Accept
* Reject
* Report

### 2.9 Match

#### Match

Relationship state between two users.

Created by mutual Like or accepted Nakh.

#### MatchParticipant

User membership inside a Match.

Keeps participant-level data separate from the Match itself.

#### UnmatchRecord

Record of an unmatch action.

Tracks who unmatched, when it happened, and the 24-hour post-unmatch report window.

### 2.10 Chat

#### ChatSession

Internal bot relay chat created from a Match.

A ChatSession does not exist without a Match.

#### ChatParticipant

User membership inside a ChatSession.

Stores participant-level chat data such as last read time and mute state.

#### ChatMessage

Message sent inside an internal bot relay chat.

Only predefined messages are allowed before unlock. Only text messages are allowed after unlock.

#### ChatMessageSnapshot

Frozen copy of chat messages for moderation/report review.

Used when a chat or message is reported.

#### PredefinedQuestionSet

Group or topic for predefined chat questions.

#### PredefinedQuestion

Data-driven question available in free predefined chat.

#### PredefinedAnswer

Data-driven answer option for a predefined question.

#### ChatUnlock

Chat-specific unlock state for a Match.

If one side unlocks chat, both users can send text in that match.

#### ChatSafetyWarning

Record that the one-time chat unlock safety warning was shown.



### 2.11 Payment

#### CreditAccount

Stores the user’s current credit balance.

#### CreditTransaction

Records every credit balance change.

Examples:

* Purchase
* Spend on Nakh
* Spend on chat unlock
* Spend on Liked By unlock
* Refund
* Admin adjustment

#### CreditPackage

Purchasable bundle of credits.

Exact package sizes and discounts are not finalized yet.

#### PaymentRecord

Internal record of a payment attempt and result.

#### TelegramStarsPayment

Telegram Stars-specific payment data.

#### PaymentProviderEvent

Raw payment callback/event from Telegram.

Used for audit and idempotency.

#### PendingPayment

Unpaid payment needed to complete a paid action.

Examples:

* Send Nakh
* Unlock chat
* Unlock Liked By profile
* Buy credit package

#### RefundRecord

Refund or payment correction record.

### 2.12 Notification

#### Notification

Stored notification shown in notification history.

#### NotificationDelivery

Telegram or in-app delivery attempt for a notification.

#### NotificationPreference

User notification settings.

Normal notifications can be muted. Safety, payment, admin, ban, and restriction notices cannot be muted.

### 2.13 Moderation

#### Report

User-submitted complaint against another user, profile, photo, chat, message, or recently unmatched user.

#### ReportReason

Allowed reason for submitting a report.

#### ReportEvidence

Context attached to a report.

Examples:

* Profile
* Photo
* Chat
* Message
* Unmatched user

#### ReportSnapshot

Frozen copy of reported context at report time.

Used so evidence is not lost after edits or cleanup.

#### ModerationReview

Admin review process for reports or safety cases.

#### ModerationAction

Action taken by admin or moderation logic.

Examples:

* Restrict user
* Unrestrict user
* Ban user
* Unban user
* Hide photo
* Restore photo
* Dismiss report

### 2.14 Admin

#### AdminUser

Telegram user allowed to use admin tools.

#### AdminRole

Role assigned to an admin user.

Examples:

* Super admin
* Moderator
* Support

#### AdminPermission

Specific permission available to admins.

Examples:

* View reports
* Restrict user
* Ban user
* Hide photo
* Review support

#### AdminUserRole

Connection between admin users and admin roles.

#### AdminRolePermission

Connection between admin roles and permissions.

#### AdminActionLog

Trace of admin actions.

Every admin action must be logged.

### 2.15 Support

#### SupportThread

Support conversation between a user and support/admin.

#### SupportMessage

Individual message inside a support thread.

Support messages must be rate-limited.

#### UserAppeal

Limited appeal/support action available to banned users.

### 2.16 Config, Localization, Jobs, and Audit

#### SystemConfig

Configurable product constants.

Examples:

* Guest preview limit
* Minimum signup age
* Photo limits
* Interest limits
* Text length limits
* Paid feature costs
* Nakh expiry duration

#### Locale

Supported language/locale.

MVP uses English.

#### UIText

Configurable user-facing text.

Used for button labels, messages, errors, admin texts, payment texts, notification texts, and safety texts.

#### ScheduledJob

Defined recurring or background job.

Examples:

* Expire Nakh
* Expire pending payment
* Send pending payment reminder
* Cleanup chat messages
* Retry notification delivery

#### JobRunLog

Execution log for a scheduled/background job.

#### AuditLog

General trace of important system events.

#### PaymentAuditLog

Payment-specific audit trail.

#### SafetyAuditLog

Safety and moderation-specific audit trail.

#### DataRetentionRecord

Record of minimal retained data after account deletion.

#### RateLimitRecord

Rate limit tracking for sensitive actions.

Examples:

* Support message
* Report submit
* Photo upload
* Payment attempt
* Appeal

## 3. Supporting Entities

Supporting entities are not always user-facing, but they are needed for correctness, auditability, moderation, or operational safety.

Supporting entities include:

* AccountStateHistory
* AccountDeletionRecord
* ProfileChangeRequest
* ProfileChangeReview
* PhotoModerationRecord
* UserPairState
* NakhStatusHistory
* NakhReceiverAction
* MatchParticipant
* ChatParticipant
* ChatMessageSnapshot
* ChatUnlock
* ChatSafetyWarning
* PaymentProviderEvent
* RefundRecord
* NotificationDelivery
* NotificationPreference
* ModerationReview
* ModerationAction
* AdminRole
* AdminPermission
* AdminUserRole
* AdminRolePermission
* AdminActionLog
* UserAppeal
* AuditLog
* PaymentAuditLog
* SafetyAuditLog
* DataRetentionRecord
* ScheduledJob
* JobRunLog
* Locale
* UIText
* RateLimitRecord
* UserBlock


## 4. Profile Option Entities

Some profile options can be modeled as enums/config values first.

If admin-editable options are needed later, they can be converted into lookup tables.

### Language

Selectable spoken language option.

Used by profile language selection.

### ProfileLanguage

Connection between a profile/user and a spoken language.

### PersonalityTag

Selectable personality tag.

### ProfilePersonalityTag

Connection between a profile/user and a selected personality tag.

## 5. Enum / Config Values

These are not domain entities by default.

They should be modeled as enums or config values unless product requirements later require admin-editable lookup tables.

### Gender

MVP values:

* Man
* Woman
* Other
* Prefer not to say

### InterestedGender

MVP values:

* Men
* Women
* Everyone

### RelationshipGoal

MVP values:

* Serious relationship
* Casual dating
* Friendship
* Marriage
* Not sure yet

### SmokingPreference

Optional profile value.

Exact options are not finalized yet.

### PetsPreference

Optional profile value.

Exact options are not finalized yet.

### ExerciseFrequency

Optional profile value.

Exact options are not finalized yet.

### ReligionImportance

Optional profile value.

Exact options are not finalized yet.

### ChildrenPreference

Optional profile value.

Exact options are not finalized yet.

### EducationLevel

Optional profile value.

Exact options are not finalized yet.

## 6. Optional / Later Entities

These are useful but not required for the first implementation.

### ExploreSession

Tracks an Explore browsing session.

Useful for analytics, debugging, and abuse detection.

Not required for MVP core functionality.

### UserActivityLog

Tracks lightweight user activity.

Useful for debugging and abuse detection.

Not required for MVP core functionality.

## 7. Removed / Rejected Entities

These entities should not be included in the MVP domain model.

### RelationshipGoal Entity

Rejected because relationship goal is currently an enum/config value.

### LikedByUnlock

Rejected because scoped paid unlocks are handled by FeatureUnlock.

### ProfileViewEvent

Rejected because ExploreConsumption already records profile preview and action consumption.

### DeviceSession

Rejected because TelegramIdentity is enough for MVP.

The product does not manage normal device login sessions.

### ReportMessageSnapshot

Rejected because ReportSnapshot and ChatMessageSnapshot cover moderation evidence.

### PendingAction

Rejected because PendingPayment and PendingNakh cover the required pending flows.

## 8. Notes

* User and Profile must stay separate.
* Account and Profile must stay separate.
* Like and Nakh must stay separate.
* PendingNakh and Nakh must stay separate.
* FeatureUnlock should handle scoped paid unlocks.
* UserPairState is a summary entity, not a replacement for Like, Nakh, Match, or NotInterested.
* ExploreConsumption is required for the no-repeat profile rule.
* PaymentProviderEvent is required for payment idempotency.
* ReportSnapshot is required so moderation evidence survives later edits or cleanup.
* SystemConfig should hold product constants that may change later.




