# Entities

This file lists the domain entities for the Telegram Dating Bot MVP.

These are domain entities, not final database tables.

## 1. Identity and Account

### User

Main internal system identity for a Telegram person.

### TelegramIdentity

External Telegram identity attached to a user.

### Account

Access and lifecycle state of the user.

### AccountStateHistory

History of account state changes.

### AccountDeletionRecord

Record of user account deletion and retained deletion metadata.

### GuestPreviewCounter

Permanent preview counter shared by guest and incomplete users.

### UserSettings

General user settings.

Includes:

* Visibility
* Language

### UserBlock

Internal block/safety relation between two users.

Used to prevent future interaction when needed.

---

## 2. Signup

### SignupProgress

Current progress in the signup flow.

### SignupDraft

Temporary stored signup answers before profile completion.

---

## 3. Profile

### Profile

Dating-visible user profile.

### ProfileOptionalDetails

Optional profile fields.

### Interest

Selectable interest item.

### UserInterest

Selected interests for a user/profile.

### Language

Selectable spoken language option.

### ProfileLanguage

Languages selected by a user/profile.

### PersonalityTag

Selectable personality tag.

### ProfilePersonalityTag

Personality tags selected by a user/profile.

### ProfileChangeRequest

Request to change locked profile fields.

Allowed locked fields:

* Birth year
* Gender

### ProfileChangeReview

Admin review result for a profile change request.

---

## 4. Location

### Country

Top-level location.

MVP supports Iran only.

### Province

Province/state under country.

### City

City under province.

MVP uses a fixed city list and has no “Other” city option.

---

## 5. Media

### MediaAsset

Stored uploaded file metadata.

### ProfilePhoto

Photo attached to a profile.

### PhotoVariant

Generated version of a photo.

Examples:

* Thumbnail
* Blurred preview

### PhotoModerationRecord

Moderation record for a profile photo.

---

## 6. Explore

### ExploreFilter

User’s active Explore filter values.

### ExploreConsumption

Permanent record that a viewer has already seen or acted on a target profile.

### ExploreSession

Optional Explore browsing session record.

Not required for first MVP implementation.

---

## 7. Interaction

### Like

Free weak signal from one user to another.

Appears in receiver’s Liked By.

### NotInterested

Permanent negative action from one user toward another.

### UserPairState

Current summarized state between two users.

Used to prevent invalid actions.

### FeatureUnlock

Paid unlock for a scoped feature.

Examples:

* Liked By profile unlock
* Chat unlock

---

## 8. Nakh

### PendingNakh

Unpaid Nakh attempt.

Visible only to sender.

### Nakh

Paid strong signal delivered to receiver.

Appears in Nakhes, not Liked By.

### NakhStatusHistory

History of Nakh status changes.

### NakhReceiverAction

Receiver action on a Nakh.

Examples:

* View profile
* Accept
* Reject
* Report

---

## 9. Match

### Match

Relationship state between two users.

Created by:

* Mutual Like
* Accepted Nakh
* Nakh Like Back

### MatchParticipant

User membership inside a match.

### UnmatchRecord

Record of unmatch action and report window.

---

## 10. Chat

### ChatSession

Internal bot relay chat created from a match.

### ChatParticipant

User membership inside a chat session.

### ChatMessage

Stored chat message.

### ChatMessageSnapshot

Frozen copy of chat messages for moderation/report review.

### PredefinedQuestionSet

Group/topic for predefined chat questions.

### PredefinedQuestion

Data-driven free-chat question.

### PredefinedAnswer

Data-driven answer option.

### ChatUnlock

Chat-specific unlock state.

If one side unlocks, both sides can send text messages in that match.

### ChatSafetyWarning

Record that the safety warning was shown after chat unlock.

---

## 11. Payment

### CreditAccount

User credit balance.

### CreditTransaction

Record of every credit increase or decrease.

### CreditPackage

Purchasable credit bundle.

### PaymentRecord

Internal payment attempt/result record.

### TelegramStarsPayment

Telegram Stars payment-specific data.

### PaymentProviderEvent

Raw Telegram payment callback/event.

Used for audit and idempotency.

### PendingPayment

Unpaid payment needed to complete a paid action.

### RefundRecord

Refund or correction record.

---

## 12. Notification

### Notification

Stored notification shown in notification history.

### NotificationDelivery

Telegram or in-app delivery attempt/result.

### NotificationPreference

User notification settings.

---

## 13. Reporting and Moderation

### Report

User-submitted complaint.

### ReportReason

Allowed report reason.

### ReportEvidence

Attached report context.

Examples:

* Profile
* Photo
* Chat
* Message
* Unmatched user

### ReportSnapshot

Frozen copy of reported context.

### ModerationReview

Admin review process for a report or safety issue.

### ModerationAction

Moderation action applied by admin/system.

Examples:

* Restrict user
* Ban user
* Hide photo
* Dismiss report

---

## 14. Admin

### AdminUser

Telegram user allowed to use admin tools.

### AdminRole

Role assigned to an admin user.

### AdminPermission

Specific permission available to admins.

### AdminUserRole

Join entity between admin users and roles.

### AdminRolePermission

Join entity between admin roles and permissions.

### AdminActionLog

Trace of admin actions.

---

## 15. Support and Appeals

### SupportThread

Support conversation/thread between user and support/admin.

### SupportMessage

Individual support message.

### UserAppeal

Limited appeal from banned user.

---

## 16. Audit and Safety

### AuditLog

General important system event log.

### PaymentAuditLog

Payment-specific audit trail.

### SafetyAuditLog

Safety/moderation-specific audit trail.

### DataRetentionRecord

Tracks minimal retained data after account deletion.

---

## 17. Jobs

### ScheduledJob

Defined recurring/background job.

### JobRunLog

Execution log for background jobs.

---

## 18. Localization

### Locale

Supported language/locale.

### UIText

Configurable user-facing text key/value.

---

## 19. Configuration and Rate Limiting

### SystemConfig

Runtime product configuration.

Examples:

* Guest preview limit
* Minimum signup age
* Photo limits
* Interest limits
* Nakh expiry duration
* Paid feature costs

### RateLimitRecord

Rate-limit tracking for sensitive actions.

Examples:

* Support messages
* Report submission
* Photo upload
* Payment attempts
* Admin appeals

---

# Entity Classification

## Core MVP Entities

These are mandatory for the MVP.

* User
* TelegramIdentity
* Account
* Profile
* ProfileOptionalDetails
* ProfilePhoto
* MediaAsset
* PhotoVariant
* Country
* Province
* City
* Interest
* UserInterest
* SignupProgress
* SignupDraft
* GuestPreviewCounter
* ExploreFilter
* ExploreConsumption
* Like
* NotInterested
* PendingNakh
* Nakh
* Match
* UnmatchRecord
* ChatSession
* ChatMessage
* PredefinedQuestionSet
* PredefinedQuestion
* PredefinedAnswer
* CreditAccount
* CreditTransaction
* CreditPackage
* PaymentRecord
* TelegramStarsPayment
* PendingPayment
* FeatureUnlock
* Notification
* Report
* ReportReason
* ReportEvidence
* ReportSnapshot
* AdminUser
* SupportThread
* SupportMessage
* SystemConfig

## Supporting Entities

These are needed for correctness, auditability, moderation, or clean implementation.

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

## Profile Option Entities

These support multi-select profile options.

* Language
* ProfileLanguage
* PersonalityTag
* ProfilePersonalityTag

## Optional / Later Entities

These are useful, but not required for first MVP implementation.

* ExploreSession

## Removed / Not Needed Entities

These should not be added.

* RelationshipGoal entity
* LikedByUnlock entity
* ProfileViewEvent
* DeviceSession
* ReportMessageSnapshot
* PendingAction

Use instead:

* RelationshipGoal as enum/config
* FeatureUnlock for Liked By unlock
* ExploreConsumption for profile views
* TelegramIdentity instead of DeviceSession
* ChatMessageSnapshot and ReportSnapshot for report evidence
* PendingPayment and PendingNakh instead of generic PendingAction
