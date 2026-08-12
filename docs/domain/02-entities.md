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

Tracks deletion time, product-data deletion, chat closure, and whether the same Telegram identity may use the product again.

Account deletion permanently removes previous non-safety product data.

AccountDeletionRecord must not be used to restore old profile, payment, Match, chat, Nakh, Like, credit, or FeatureUnlock data.

Safety, abuse-prevention, restriction, ban, moderation, and required safety-evidence history remain linked to the persistent User/TelegramIdentity.

The permanent GuestPreviewCounter also remains and is not reset by account deletion.

If the user is later allowed to return, they start the dating profile/signup flow from zero.

#### GuestPreviewCounter

Permanent preview counter for guest and incomplete users.

The counter is shared by Telegram identity/user and does not reset during incomplete signup.

GuestPreviewCounter is created on first `/start` for a new Telegram user.

It is tied to the persistent User/TelegramIdentity, not to a temporary session.

It does not reset when the account moves from `guest` to `incomplete`.

After account activation, the counter remains for audit/history but no longer controls normal Explore access.

#### UserSettings

General user settings.

Owns visibility and language preference.

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

Gender values are controlled for MVP but must remain extensible because additional gender options may be added later.

Gender should not be treated as a permanently fixed database enum during implementation.

Interested gender should also remain extensible.

Implementation should treat interested gender as a configurable preference option that maps to one or more gender options.

Explore gender compatibility must not be hardcoded only around Man/Woman.

Profile also carries a non-user-facing `random_shuffle_key` used for Explore candidate ordering.

The key is discovery infrastructure metadata, not dating-visible profile data.

It should be refreshed periodically to avoid stable ordering and repeated exposure bias.

#### ProfileOptionalDetails

Optional profile information.

Includes optional data such as height, job title, education level, smoking preference, pets preference, exercise frequency, religion importance, and children preference.

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

Selectable spoken language option for dating profiles.

This represents languages a user can speak, not the bot UI language.

MVP should include English as an available spoken-language option.

Additional spoken languages can be added later by adding new Language records.

Profile spoken languages must not be hardcoded as free text.

#### ProfileLanguage

Connection between a profile and selected spoken languages.

Spoken languages belong to the dating profile, not directly to the user account.

#### PersonalityTag

Selectable personality tag for dating profiles.

Personality tags are profile option records, not hardcoded strings inside bot logic.

Additional personality tags can be added later by adding new PersonalityTag records.

#### ProfilePersonalityTag

Connection between a profile and selected personality tags.

Personality tags belong to the dating profile, not directly to the user account.

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

Cloudflare R2 is the MVP object storage provider.

Cloudflare Images/CDN is the MVP media delivery provider.

The domain model must not depend on Cloudflare-specific storage or delivery semantics.

Storage access should remain behind an S3-compatible provider abstraction.

Media delivery should remain behind a CDN/provider abstraction so either provider can be replaced later without changing domain behavior.

#### ProfilePhoto

Photo attached to a dating profile.

Controls primary photo status, display order, and photo visibility.

#### PhotoVariant

Generated version of a media asset.

MVP variant types:

* Thumbnail
* Blurred preview

Generation behavior differs by variant type:

* Thumbnail is generated during upload processing before the ProfilePhoto becomes visible.
* Blurred preview is generated on demand when needed for a locked Liked By card and then cached.

PhotoVariant therefore contains both upload-time generated variants and cached on-demand variants.

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

### 2.7 Interaction

#### Like

Free weak signal from one user to another.

A normal Like appears in the receiver’s Liked By section.

A normal Like is permanent in MVP and cannot be undone, cancelled, or withdrawn by the sender.

#### NotInterested

Permanent negative action from one user toward another.

Used when a user rejects a profile from Explore, Liked By, cancelled Pending Nakh, or unmatch flow.

#### UserPairState

Current symmetric summary state between two users.

Used to prevent invalid pair-level actions after match, unmatch, or block.

UserPairState must not store directional actions such as Like, Not Interested, Pending Nakh, or Sent Nakh.

Directional actions are stored in their own source entities.

#### FeatureUnlock

Paid unlock record for a scoped feature.

Used for:

* Liked By profile unlock
* Chat unlock

Feature unlocks can expire or be revoked depending on feature type and configuration.

Nakh is not modeled as a FeatureUnlock. Nakh is a paid action, not persistent feature access.

FeatureUnlock ownership:

* FeatureUnlock records the payer of a paid unlock.
* The payer is not always the only user who receives access.
* For Liked By unlock, access is user-scoped.
* For Chat unlock, access is Match-scoped.
* If one matched user unlocks chat, both users in that Match can send text.

### 2.8 Nakh

#### PendingNakh

Unpaid Nakh attempt.

Visible only to the sender.

Does not notify the receiver, does not create Like, does not appear in Liked By, and does not create Match.

A sender may have at most 5 concurrent PendingNakh records with status `pending_payment`.

PendingNakhes form a sender-level unpaid queue ordered by `created_at`.

When credits are added to the sender’s CreditAccount, eligible unpaid PendingNakhes are automatically settled in FIFO order while sufficient credits remain.

An unpaid PendingNakh expires after 14 days.

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

Chat-specific marker that a Match chat has been unlocked.

One ChatUnlock belongs to one Match.

One ChatUnlock belongs to one FeatureUnlock.

ChatUnlock does not own payment, credit, expiry, revocation, or unlock status.

FeatureUnlock is the source of truth for paid unlock state.

If one side unlocks chat, both users can send text in that Match.

The other matched user does not need to pay again for the same Match.

Chat unlock does not expire in MVP.

ChatUnlock is the chat-specific state showing that one Match has unlocked text chat.

The user who paid is stored as the unlock payer/unlocker, but the unlocked access applies to both users in the Match.

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

MVP package records are:

* Starter — 10 credits — 10 Stars
* Plus — 25 credits — 20 Stars — Popular
* Best Value — 50 credits — 35 Stars — Best Value
* Ultimate — 100 credits — 60 Stars — Best Value

CreditPackage is data/configuration, not a hardcoded payment-handler concept.

Package records may later be changed or deactivated without changing the payment domain model.

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
* Delete photo
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
* Restore photo
* Delete photo
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

Support conversation between a non-banned user and support/admin.

Banned users cannot create SupportThread records.

#### SupportMessage

Individual message inside a support thread.

Support messages must be rate-limited.

#### UserAppeal

Limited ban appeal available to banned users.

UserAppeal is the canonical MVP mechanism for banned-user appeal.

Banned users do not create `SupportThread` or `SupportMessage`.

One UserAppeal is allowed per ban event.

### 2.16 Config, Localization, Jobs, and Audit

#### SystemConfig

Configurable product constants.

Examples:

* Guest preview limit
* Minimum allowed birth year
* Birth year validation format
* Minimum signup age
* Photo limits
* Interest limits
* Text length limits
* Paid feature costs
* Nakh expiry duration
* Report threshold unique reporter count
* Report threshold window days
* Explore candidate pool limit
* Explore shuffle-key refresh schedule
  
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
* Send Pending Nakh payment reminders
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

Record of safety and abuse-prevention data retained after account deletion.

It must not retain ordinary deleted product data for later restoration.

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

## 4. Profile Option Entities

Profile option entities are selectable profile values that should be data-driven.

For MVP, the following profile option entities are included in the domain model:

* Interest
* Language
* PersonalityTag

Their profile connections are:

* ProfileInterest
* ProfileLanguage
* ProfilePersonalityTag

These should not be modeled as random free-text fields.

These should not be confused with UI localization.

UI localization is handled by `Locale`, `UIText`, and `UserSettings.language_code`.

The following optional profile values are controlled enums for MVP:

* EducationLevel
* SmokingPreference
* PetsPreference
* ExerciseFrequency
* ReligionImportance
* ChildrenPreference

They must not be stored as arbitrary free text.

Education represents education level, not exact major.

These values may later be migrated to admin-editable lookup records if product requirements change.


## 5. Enum / Config Values

These are not domain entities by default.

They should be modeled as enums or config values unless product requirements later require admin-editable lookup tables.

### Gender

MVP values:

* Man
* Woman
* Other
* Prefer not to say

Gender options must remain extensible.

Future gender options should be addable through configuration or lookup data.

### InterestedGender

MVP values:

* Men
* Women
* Everyone

InterestedGender values must map to one or more Gender values.

MVP mapping:

* Men -> Man
* Women -> Woman
* Everyone -> all active visible Gender values

Future interested-gender options should be addable through configuration or lookup data.

### RelationshipGoal

MVP values:

* Serious relationship
* Casual dating
* Friendship
* Marriage
* Not sure yet

### SmokingPreference

Optional controlled enum for MVP.

Exact enum values are not finalized yet.

### PetsPreference

Optional controlled enum for MVP.

Exact enum values are not finalized yet.

### ExerciseFrequency

Optional controlled enum for MVP.

Exact enum values are not finalized yet.

### ReligionImportance

Optional controlled enum for MVP.

Exact enum values are not finalized yet.

### ChildrenPreference

Optional controlled enum for MVP.

Exact enum values are not finalized yet.

### EducationLevel

Optional controlled enum for MVP.

Represents education level, not exact major.

Exact enum values are not finalized yet.

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

### UserBlock

Rejected for MVP.

Users cannot block other users in MVP.

Admins also do not have a pair-level block action in MVP.

If a user has a safety issue, the user should submit a Report.

Admin review can result in existing moderation actions such as restricting the user, banning the user, hiding/restoring a photo, or dismissing the report.

Pair-level rediscovery prevention is handled by existing source records such as NotInterested, Match, UnmatchRecord, and UserPairState where applicable.

A user-facing block feature may be added later if product requirements change

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




