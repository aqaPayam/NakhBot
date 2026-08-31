# Domain Entities

This catalog defines entity responsibilities and boundaries. It is a logical model, not a required one-table-per-entity database design.

## 1. Identity, account, and signup

### User

Persistent internal identity and owner of account-level data. The User ID, not a Telegram username, is the internal reference used by the domain.

### TelegramIdentity

One-to-one Telegram identity for a User. It is the lookup point for every incoming Telegram update.

### Account

One-to-one access and lifecycle state for a User. It does not own dating-visible Profile fields.

### AccountStateHistory

Append-only history of every Account transition, including actor and reason. A ban event is identified by the history record that transitions into `banned`.

### AccountDeletionRecord

One record per deletion event. It records purge completion and whether a later fresh signup is allowed; it cannot restore deleted product data.

### GuestPreviewCounter

One permanent counter per User for Guest and Incomplete preview consumption. It survives activation and deletion.

### UserSettings

One-to-one user-controlled settings: visibility and UI locale. Notification mute choices belong to NotificationPreference.

### SignupProgress

The current signup step and completion timestamps.

### SignupDraft

Temporary, resumable answers collected before Profile confirmation. Draft values never affect Guest Preview.

## 2. Profile options, Profile, and location

### GenderOption

Data-driven gender catalog. MVP seeds `man`, `woman`, and `other`; future values do not require discovery-code changes.

### GenderPreference

Data-driven relationship-preference catalog such as `men`, `women`, and `everyone`.

### GenderPreferenceMember

Mapping from a GenderPreference to one or more GenderOptions. This mapping is the source used by reciprocal compatibility.

### Profile

The User's current dating-visible identity and completion state. Approximate age is derived from Gregorian birth year.

### ProfileOptionalDetails

One-to-one optional lifestyle and background fields for a Profile.

### Interest and ProfileInterest

Interest is an active, ordered option. ProfileInterest is the many-to-many selection and enforces uniqueness per Profile/Interest.

### Language and ProfileLanguage

Language is a spoken-language option. ProfileLanguage is the many-to-many Profile selection and is unrelated to UI locale.

### PersonalityTag and ProfilePersonalityTag

PersonalityTag is an active, ordered option. ProfilePersonalityTag is the many-to-many Profile selection.

### ProfileChangeRequest

A User request to change birth year or gender after signup.

### ProfileChangeReview

The single admin decision for a ProfileChangeRequest.

### Country, Province, and City

Hierarchical location catalogs. Country owns Provinces; Province owns Cities. MVP Profile location must resolve to an active seeded Iranian City.

## 3. Media

### MediaAsset

The original validated upload's metadata, hashes, storage key, and lifecycle. Cloudflare R2/CDN details are accessed through provider abstractions.

### ProfilePhoto

The assignment of one MediaAsset to one Profile, including order, primary flag, and moderation status.

### PhotoVariant

A generated thumbnail or blurred preview belonging to a MediaAsset. Thumbnail and blurred-preview generation have different lifecycles.

### PhotoModerationRecord

Append-only history of admin hide, restore, and delete actions for a ProfilePhoto.

## 4. Discovery and interaction

### ExploreFilter

One User's saved current browsing filters: target gender subset, age range, City, and optional relationship goal. It never changes Profile relationship preference.

### ExploreConsumption

Directional record that a viewer was actually shown or acted on a target. A unique viewer/target pair prevents repeat discovery.

### Like

Directional free signal. Its lifecycle status supports the derived Liked By inbox and closure after Match or Unmatch.

### NotInterested

Directional rejection created from Explore, Liked By, or Pending Nakh cancellation.

### UserPairState

Symmetric current state for a normalized user pair. Only terminal or safety-significant states are stored: matched, unmatched, or blocked. Absence means no pair state.

### FeatureUnlock

Paid access scoped either to one received Like or to one Match. It records the payer and funding reference. It is the sole unlock source of truth; there are no separate LikedByUnlock or ChatUnlock entities.

## 5. Nakh

### NakhFlow

Stable directional sender/receiver anchor with a unique pair constraint. A flow is created before either a PendingNakh or a directly funded Nakh and prevents a second directional attempt.

### PendingNakh

Sender-only unpaid phase of a NakhFlow. It owns editable pre-payment text, expiry, cancellation resolution, and auto-settlement authorization.

### Nakh

Paid and delivered phase of a NakhFlow. It owns delivered text and receiver-visible lifecycle status.

### NakhStatusHistory

Append-only history of delivered Nakh status changes.

### NakhReceiverAction

Append-only record of receiver actions: view Profile, accept, reject, or report.

## 6. Match and chat

### Match

Unique normalized pair relationship created by mutual Likes or Nakh acceptance.

### MatchParticipant

Exactly two participant memberships for a Match.

### UnmatchRecord

The single closure record identifying who unmatched and the deadline for either participant's post-unmatch Report.

### ChatSession

One-to-one bot-relay chat for a Match. Text permission is derived from an effective Match-scoped FeatureUnlock.

### ChatParticipant

Exactly two per ChatSession. Owns read state, mute state, and the one-time unlock safety-warning timestamp.

### ChatMessage

A predefined question, predefined answer, free text, or system message in a ChatSession.

### ChatMessageSnapshot

Immutable copy of reported message context. It remains independent of normal chat-retention cleanup.

### PredefinedQuestionSet, PredefinedQuestion, and PredefinedAnswer

Active, ordered, localized data for free chat. Message records reference the selected question or answer.

## 7. Payments and credits

### CreditAccount

One balance per User.

### CreditTransaction

Immutable ledger entry for every balance change. The ledger, not a recalculated payment total, explains the current CreditAccount balance.

### CreditPackage

Active, ordered data describing a bundle of credits and its full Telegram Stars price.

### PendingPayment

The product-level action or package purchase awaiting funding. It links provider attempts to exactly one intended result.

### PaymentRecord

One Telegram Stars invoice/payment attempt and its provider lifecycle.

### TelegramStarsPayment

Telegram-specific successful-charge details separated from the provider-independent PaymentRecord.

### PaymentProviderEvent

Raw Telegram callback with a unique provider event ID. It is the idempotency boundary for callback processing.

### RefundRecord

Idempotent automatic correction for a system-fault failure after successful funding.

## 8. Notifications

### Notification

Durable in-app notification with read state, localization keys, and a typed payload.

### NotificationDelivery

One channel delivery attempt for a Notification, including retries and failure details.

### NotificationPreference

One User's mute settings for mutable notification categories.

## 9. Moderation, admin, support, and appeal

### ReportReason

Active, ordered reason catalog used by Reports.

### Report

Complaint from one User about another, with review status and optional bounded text.

### ReportEvidence

Typed references to the Profile, photo, chat, message, or UnmatchRecord that the Report concerns.

### ReportSnapshot

Immutable serialized context captured at Report creation.

### ModerationReview

The review workflow for a Report.

### ModerationAction

An append-only admin or system safety action against a User or photo.

### AdminUser

An enabled Telegram-backed administrator identity.

### AdminRole, AdminPermission, AdminUserRole, and AdminRolePermission

Role-based access control for Telegram admin commands.

### AdminActionLog

Append-only trace for every attempted state-changing admin command, including success or failure.

### SupportThread and SupportMessage

Non-banned user support conversation and its messages.

### UserAppeal

The one allowed ban appeal for one AccountStateHistory ban event.

## 10. Configuration, localization, jobs, audit, and retention

### SystemConfig

Typed key/value product configuration. It contains tunable values, not user-facing text, secrets, enums, or seed catalogs.

### Locale and UIText

Locale identifies a UI language. UIText maps a stable localization key and category to text in that Locale.

### ScheduledJob and JobRunLog

Recurring/background job definition and append-only execution history.

### AuditLog, PaymentAuditLog, and SafetyAuditLog

Append-only general, payment, and safety traces. Separate logs may share infrastructure but retain their access and retention policies.

### DataRetentionRecord

Explanation of data retained after account deletion for a permitted safety purpose. It is not a container for deleted product data.

### RateLimitRecord

Windowed counter or block record for abuse-sensitive actions.

## 11. Explicitly rejected entities

- `LikedByCard`: Liked By is a derived view.
- `LikedByUnlock` and `ChatUnlock`: FeatureUnlock owns both scopes.
- `UserBlock`: MVP blocking is internal UserPairState.
- `ProfileViewEvent`: ExploreConsumption owns no-repeat discovery.
- `DeviceSession`: TelegramIdentity is sufficient for MVP.
- `RelationshipGoal` table: a controlled enum is sufficient for MVP.
- `Age`: derived from Profile.birth_year.
- `Wallet`: CreditAccount exists, but Wallet is not an MVP main-menu surface.

