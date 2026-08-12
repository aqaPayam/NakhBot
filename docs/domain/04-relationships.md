# Domain Relationships

This file defines how domain entities are connected.

These are domain-level relationships, not final database foreign keys. Database constraints, indexes, and implementation details will be designed later.

## 1. Identity, Account, Signup, Profile, and Location Relationships

### User and TelegramIdentity

* User has one TelegramIdentity.
* TelegramIdentity belongs to one User.

Notes:

* Internal user ID is the main system identifier.
* Telegram user ID is the external platform identifier.
* Telegram username is optional and mutable.

Deletion does not break the minimal identity relationship needed for safety and abuse prevention.

The same TelegramIdentity remains linked to the persistent User after deletion.

The same Telegram identity must not bypass retained restrictions, bans, moderation history, safety history, abuse-prevention state, or required safety evidence by deleting and returning.

Payment history and other normal product history are not retained for account restoration.

### User and Account

* User has one Account.
* Account belongs to one User.

Account owns:

* Account state
* Restriction state
* Ban state
* Deletion state
* Reactivation state

### User and AccountStateHistory

* User has many AccountStateHistory records.
* AccountStateHistory belongs to one User.

Used for:

* Restriction history
* Ban history
* Deletion history
* Reactivation history
* Admin-driven state changes

### AccountStateHistory and UserAppeal

* A ban AccountStateHistory record can have one UserAppeal.
* UserAppeal belongs to the AccountStateHistory record that changed the account state to `banned`.

Rule:

* `UserAppeal.ban_state_history_id` must reference an AccountStateHistory record where `new_state = banned`.

### User and AccountDeletionRecord

* User can have AccountDeletionRecords.
* AccountDeletionRecord belongs to one User.

Used when:

* User deletes account
* Previous non-safety product data is permanently removed
* Chats are closed
* Safety and abuse-prevention retention is tracked
* Future access by the same Telegram identity must preserve safety continuity

### User and GuestPreviewCounter

* User has one GuestPreviewCounter.
* GuestPreviewCounter belongs to one User.

GuestPreviewCounter is created on first `/start` for a new Telegram user.

Rule:

* Guest and incomplete users share the same permanent preview counter.
* Starting signup does not reset the counter.
* Completing signup does not delete the counter.
* After account activation, the counter remains for audit/history but no longer controls normal Explore.
* The counter controls Guest Preview only.
* Guest Preview is separate from normal Explore.
* Guest Preview does not use ExploreFilter or Profile gender compatibility.

### User and UserSettings

* User has one UserSettings.
* UserSettings belongs to one User.

UserSettings owns:

* Visibility setting
* Language preference

Notification preferences are handled by NotificationPreference.

### User and SignupProgress

* User has one SignupProgress.
* SignupProgress belongs to one User.

Used while signup is incomplete.

### User and SignupDraft

* User has one SignupDraft.
* SignupDraft belongs to one User.

Purpose:

* Stores temporary signup answers before profile completion.

### User and Profile

* User can have zero or one current Profile.
* Profile belongs to one User.

On account deletion, previous dating-profile data is permanently removed and must not be recoverable.

If the same Telegram identity is later allowed to return, the user starts profile/signup from zero.

Old profile fields must not be restored.

Safety records and required safety evidence remain separate from dating-visible Profile data.

Important distinction:

* User owns persistent identity and safety linkage.
* Profile owns current dating-visible information.

### Profile and ProfileOptionalDetails

* Profile has one ProfileOptionalDetails.
* ProfileOptionalDetails belongs to one Profile.

Optional details can be empty.

### Profile and Interest

* Profile has many Interests through ProfileInterest.
* Interest belongs to many Profiles through ProfileInterest.
* ProfileInterest connects profile_id and interest_id.

Rules:

* A complete profile must have at least 5 interests.
* A profile can have at most 20 interests.
* Interests belong to the dating profile, not directly to the user.

### Profile and ProfileChangeRequest

* Profile/User can have many ProfileChangeRequests.
* ProfileChangeRequest belongs to one User.

Used for locked fields:

* birth_year
* gender

### ProfileChangeRequest and ProfileChangeReview

* ProfileChangeRequest can have one ProfileChangeReview.
* ProfileChangeReview belongs to one ProfileChangeRequest.

Review is created when admin approves or rejects the request.

### Profile and Language

* Profile can have many spoken Languages through ProfileLanguage.
* Language can belong to many Profiles through ProfileLanguage.
* ProfileLanguage connects profile_id and language_id.

Rules:

* Spoken languages belong to the dating profile, not directly to the user account.
* Spoken languages must not be stored as free text.
* Spoken languages are not the same as UI language.
* UI language is stored separately in `UserSettings.language_code`.

### Profile and PersonalityTag

* Profile can have many PersonalityTags through ProfilePersonalityTag.
* PersonalityTag can belong to many Profiles through ProfilePersonalityTag.
* ProfilePersonalityTag connects profile_id and personality_tag_id.

Rules:

* Personality tags belong to the dating profile, not directly to the user account.
* Personality tags should be selected from supported PersonalityTag records.
* Personality tags should not be stored as free text.

### Country and Province

* Country has many Provinces.
* Province belongs to one Country.

MVP rule:

* Country is Iran only.

### Province and City

* Province has many Cities.
* City belongs to one Province.

Rules:

* City must be selected from a fixed list.
* Free-text city is not allowed.
* “Other” city is not allowed in MVP.

### Profile and Location

* Profile belongs to one Country.
* Profile belongs to one Province.
* Profile belongs to one City.

MVP location model:

* country_id = Iran
* province_id = selected province
* city_id = selected city

## 2. Media Relationships

### User and MediaAsset

* User has many MediaAssets.
* MediaAsset belongs to one User.

Purpose:

* Tracks uploaded files owned by a user.

Rules:

* User-deleted profile-photo media assets must be permanently deleted from object storage/CDN unless retention is required for moderation, safety, legal, audit, or report evidence.

### MediaAsset and ProfilePhoto

* MediaAsset can be used as one ProfilePhoto.
* ProfilePhoto belongs to one MediaAsset.

Important distinction:

* MediaAsset is the stored file.
* ProfilePhoto is the profile usage of that file.

### Profile and ProfilePhoto

* Profile has many ProfilePhotos.
* ProfilePhoto belongs to one Profile.

Rules:

* A complete profile must have at least 2 visible photos.
* A profile can have at most 6 saved profile photos.
* Saved profile photos means visible + hidden profile photos currently stored for that profile.
* Hidden photos count toward the 6-photo saved-photo limit, but do not count toward profile completion.
* Only visible photos count toward the 2-photo completion requirement.
* Deleted photos are removed from the profile and their stored media objects must be permanently deleted from object storage/CDN.
* A deleted photo no longer counts as a saved profile photo after its stored media object is deleted.
* Extra saved profile photos are rejected.
* One visible photo must be primary.
* The primary photo cannot be deleted before another visible primary photo is selected.
* If the primary photo is hidden by admin, profile validity must be rechecked.
* If a deleted photo is linked to an active report, moderation case, safety case, legal/audit case, or immutable report snapshot, the user-facing photo is removed immediately, but the evidence copy may be retained in restricted moderation/audit storage until retention rules allow deletion.


### MediaAsset and PhotoVariant

* MediaAsset can have many PhotoVariants.
* PhotoVariant belongs to one MediaAsset.

Used for:

* Thumbnail
* Blurred preview

Rules:

* Thumbnail is generated during upload processing.
* Thumbnail must exist before the related ProfilePhoto becomes visible.
* Blurred preview is generated only when needed by a locked Liked By card.
* Blurred preview is generated for the relevant primary profile photo and cached as a PhotoVariant.
* A MediaAsset does not need a blurred-preview PhotoVariant in order for its ProfilePhoto to be visible.

### ProfilePhoto and PhotoModerationRecord

* ProfilePhoto has many PhotoModerationRecords.
* PhotoModerationRecord belongs to one ProfilePhoto.

Used when:

* Photo is hidden
* Photo is restored
* Photo is deleted

## 3. Explore and Interaction Relationships

### User and ExploreFilter

* User has one ExploreFilter.
* ExploreFilter belongs to one User.

ExploreFilter owns:

* Age range
* Country
* Province
* City
* Relationship goal

MVP behavior:

* Country is fixed to Iran and is not shown as a user-facing Explore filter.
* Province is used only to group/select cities.
* Explore location filtering is city-level.
* Province-wide browsing is not included in MVP.
* Whole-country browsing is not included in MVP.


Notes:

* Interested gender is not stored in ExploreFilter.
* Interested gender belongs to Profile.
* Changing interested gender from Explore or Edit Profile updates the same profile field.

ExploreFilter does not own gender compatibility.

Gender compatibility is calculated from each profile’s `gender` and `interested_gender`.

The calculation must be reciprocal and data-driven.


### Profile and Gender Compatibility

Explore gender compatibility is evaluated between two Profiles.

A viewer Profile and target Profile are gender-compatible only if:

* The target Profile’s gender is included in the viewer Profile’s interested-gender mapping.
* The viewer Profile’s gender is included in the target Profile’s interested-gender mapping.

Gender compatibility must use configurable mappings.

The implementation must not hardcode compatibility only for Man/Woman.



### User and ExploreConsumption

* User has many ExploreConsumptions as viewer.
* User has many ExploreConsumptions as target.
* ExploreConsumption connects viewer_user_id and target_user_id.

Rules:

* Once consumed, the target profile is not shown again.
* Consumption is permanent.

Guest Preview relationship rule:

* Guest and incomplete users create `ExploreConsumption` records when teaser previews are shown.
* These records use reason `preview`.
* The target must come from the Guest Preview Pool.
* Guest Preview consumption does not require a complete viewer Profile.
* Guest Preview consumption does not require ExploreFilter.

Consumption reasons:

* Preview
* Like
* Not Interested
* Pending Nakh
* Sent Nakh
* Match

### User and Like

* User has many sent Likes.
* User has many received Likes.
* Like connects sender_user_id and receiver_user_id.

Rules:

* Normal Like appears in receiver’s Liked By.
* Nakh does not create a normal Like.
* A mutual Like can create a Match.
* Normal Likes are permanent in MVP.
* Users cannot undo, cancel, or withdraw a normal Like.
* A liked target remains consumed and must not be shown again to the same sender.

### User and NotInterested

* User has many sent NotInterested records.
* User has many received NotInterested records.
* NotInterested connects sender_user_id and receiver_user_id.

Sources:

* Explore
* Liked By
* Cancelled Pending Nakh
* Unmatch

Rule:

* A NotInterested target should not appear again.

### User Pair and UserPairState

Two users can have one UserPairState.

UserPairState belongs to exactly one normalized user pair.

Rule:

* Use normalized pair ordering: `user_a_id < user_b_id`.

Allowed pair-level states:

* none
* matched
* unmatched

Purpose:

* Stores symmetric pair-level state.
* Helps prevent invalid pair-level actions after match, unmatch, or block.

UserPairState must not store directional actions.

Directional actions must be read from source records:

* ExploreConsumption
* Like
* NotInterested
* PendingNakh
* Nakh

Examples:

* If pair is matched, prevent Like, Nakh, Not Interested, and Explore repeat.
* If pair is unmatched, prevent future Match between the same users.
* If pair is matched, unmatched, or blocked, do not show either user in the other user’s Liked By view.

Important:

* UserPairState is a summary.
* It does not replace Like, NotInterested, PendingNakh, Nakh, Match, or UnmatchRecord.

### Like and FeatureUnlock

A received normal Like can be unlocked through one or more FeatureUnlock records over time.

FeatureUnlock can unlock one specific liked-by profile for the receiver.

Rules:

* Unlocking one Liked By profile does not unlock other Likes.
* Liked By unlock is scoped to one liker/receiver pair.
* Liked By unlock expires according to configured unlock duration.
* If a Liked By unlock expires and the Like is still actionable, the card returns to locked state and may be unlocked again.
* Expired FeatureUnlock records remain as payment/audit history.
* Nakh senders do not appear in Liked By and are not unlocked through this relationship.

### Liked By derived view

Liked By is a derived inbox view, not a stored relationship.

Liked By is derived from:

* Like
* FeatureUnlock
* Match
* UserPairState
* NotInterested
* Liker Account
* Liker Profile

A Like appears in Liked By only while it is actionable.

A received Like is actionable only if:

* The Like status is `active`.
* No Match exists for the pair.
* UserPairState is not `matched`, `unmatched`, or `blocked`.
* The receiver has not marked the liker as Not Interested.
* The liker account state is `active`.
* The liker profile completion status is `complete`.
* The liker is not restricted, banned, or deleted.

Visibility off by the liker does not remove an already-sent Like from Liked By.

If a pair matches, unmatches, becomes blocked, or the receiver marks the liker as Not Interested, the Like no longer appears in Liked By.

If the liker becomes restricted, banned, deleted, or profile-invalid, the Like no longer appears as an actionable Liked By card.

### User and FeatureUnlock

* User has many FeatureUnlocks as payer.
* FeatureUnlock belongs to the user who paid for the unlock through `payer_user_id`.
* FeatureUnlock does not represent all users who receive access.

Feature unlock types:

* Liked By profile unlock
* Chat unlock

Rules:

* For Liked By unlock, the payer receives access to one specific liked-by profile.
* For Chat unlock, the payer is only the user who paid.
* Chat unlock access belongs to the Match.
* Once one matched user pays for chat unlock, both Match participants can send free-text messages in that Match.
* The other matched user must not be charged again for the same Match.

## 4. Nakh Relationships

### User and PendingNakh

* User has many sent PendingNakhes.
* User can be the target of many PendingNakhes.
* PendingNakh connects sender_user_id and receiver_user_id.

Rules:

* PendingNakh is visible only to the sender.
* PendingNakh is hidden from the receiver.
* PendingNakh does not create a Like.
* PendingNakh does not create a Match.
* PendingNakh does not appear in Liked By.
* PendingNakh consumes the target profile.
* PendingNakh starts the sender’s single allowed Nakh flow for that receiver.
* A sender/receiver pair can have only one Nakh flow ever across PendingNakh and Nakh.
* Terminal PendingNakh statuses do not allow a new Nakh flow for the same sender/receiver pair.
* A sender may have at most 5 concurrent PendingNakhes with status `pending_payment` across all receivers.
* The cap is sender-wide, not per receiver.
* Only `pending_payment` records count toward the concurrent unpaid cap.
* Unpaid PendingNakhes are ordered FIFO by `created_at`.
* When credits are added to the sender’s CreditAccount, eligible unpaid PendingNakhes are settled oldest-first while sufficient credits remain.
* An unpaid PendingNakh expires 14 days after creation.

### PendingNakh and PendingPayment

* PendingNakh belongs to one PendingPayment.
* PendingPayment can belong to one PendingNakh.

For an unpaid PendingNakh:

* PendingPayment expiry must align with PendingNakh expiry.
* Both expire after 14 days if the Nakh remains unpaid.
* If PendingNakh is auto-settled from available credits, the PendingPayment must no longer be completable.

Used when:

* Sender wants to send Nakh.
* Sender does not have enough credits.
* Payment is required before delivery.

Payment completion is allowed while sender visibility is off only if the PendingNakh was created before sender visibility was turned off.

Payment completion is allowed while receiver visibility is off only if the PendingNakh was created before receiver visibility was turned off.

Receiver visibility off blocks new discovery but does not block delivery of an already-created PendingNakh after payment succeeds.

Payment completion is blocked if the sender is restricted, banned, or deleted.

Payment completion is blocked if the receiver is restricted, banned, deleted, or profile-invalid.

### PendingNakh to Like or NotInterested

* PendingNakh can resolve into one Like.
* PendingNakh can resolve into one NotInterested.

This only happens when the sender cancels unpaid Nakh.

Cancel rules:

* Cancel and keep as Like creates a normal Like.
* Cancel and dislike creates NotInterested.

### User and Nakh

* User has many sent Nakhes.
* User has many received Nakhes.
* Nakh connects sender_user_id and receiver_user_id.

Rules:

* Paid Nakh appears in receiver’s Nakhes.
* Paid Nakh does not appear in receiver’s Liked By.
* Only one Nakh flow is allowed per sender/receiver pair across both PendingNakh and Nakh.
* A Sent Nakh can be created directly from credits or from an existing PendingNakh after successful payment.
* A sender cannot create another PendingNakh or Nakh for the same receiver after any Nakh flow already exists.
* Receiver rejection sets `Nakh.status = rejected`.
* Rejected Nakh is shown in UI as Closed.
* `Nakh.status = closed` is reserved for generic non-rejection closure cases.

### Nakh and NakhStatusHistory

* Nakh has many NakhStatusHistory records.
* NakhStatusHistory belongs to one Nakh.

Used for tracking status changes:

* Sent
* Seen
* Accepted
* Rejected
* Closed
* Expired

Rules:

* Rejected means the receiver explicitly rejected the Nakh.
* Closed means the Nakh was terminated by a generic non-rejection closure case, such as admin/moderation/system closure.
* Rejected Nakh may be displayed to users as Closed, but the internal status remains `rejected`.

### Nakh and NakhReceiverAction

* Nakh has many NakhReceiverActions.
* NakhReceiverAction belongs to one Nakh.

Receiver actions:

* View profile
* Accept
* Reject
* Report

### Nakh and Match

* Nakh can create one Match if the receiver accepts the Nakh.
* Match may be created from one Nakh.

Rules:

* PendingNakh cannot create Match.
* Sent Nakh creates Match only after receiver action.

## 5. Match and Chat Relationships

### Like and Match

* Two opposite Likes can create one Match.
* Match may be created from mutual Like.

Rule:

* A likes B and B likes A creates a Match.

### User and Match

* User has many Matches.
* Match connects exactly two users.

Rules:

* Use normalized pair ordering to prevent duplicate Matches.
* After Match, users cannot Like, send Nakh, mark Not Interested, or appear to each other in Explore again.

### Match and MatchParticipant

* Match has two MatchParticipants.
* MatchParticipant belongs to one Match.
* MatchParticipant belongs to one User.

Purpose:

* Stores participant-level Match data.

### Match and UnmatchRecord

* Match can have one UnmatchRecord.
* UnmatchRecord belongs to one Match.

Rules:

* Unmatch closes the chat visually.
* Unmatch prevents future Match between the same users.
* Unmatched users can report each other for 24 hours.

### Match and ChatSession

* Match has one ChatSession.
* ChatSession belongs to one Match.

Rule:

* No Match means no ChatSession.

### ChatSession and ChatParticipant

* ChatSession has two ChatParticipants.
* ChatParticipant belongs to one ChatSession.
* ChatParticipant belongs to one User.

Purpose:

* Stores participant-level chat state.

### ChatSession and ChatMessage

* ChatSession has many ChatMessages.
* ChatMessage belongs to one ChatSession.

Rules:

* Only predefined questions and answers are allowed before chat unlock.
* Only text messages are allowed after chat unlock.
* Store only the last 50 visible messages per chat.
* Reported chat messages can be snapshotted separately.

### ChatMessage and ChatMessageSnapshot

* ChatMessage can be copied into ChatMessageSnapshot.
* ChatMessageSnapshot belongs to a Report.

Purpose:

* Freezes moderation evidence for reported chats or messages.

### PredefinedQuestionSet and PredefinedQuestion

* PredefinedQuestionSet has many PredefinedQuestions.
* PredefinedQuestion belongs to one PredefinedQuestionSet.

### PredefinedQuestion and PredefinedAnswer

* PredefinedQuestion has many PredefinedAnswers.
* PredefinedAnswer belongs to one PredefinedQuestion.

### ChatMessage and PredefinedQuestion / PredefinedAnswer

* ChatMessage can reference one PredefinedQuestion.
* ChatMessage can reference one PredefinedAnswer.

Used when chat mode is:

* predefined_only

### Match and ChatUnlock

* Match can have one ChatUnlock.
* ChatUnlock belongs to one Match.

Rule:

* If one side unlocks chat, both users can send text in that Match.

### ChatUnlock and FeatureUnlock

* ChatUnlock belongs to one FeatureUnlock.
* FeatureUnlock may have one ChatUnlock when `feature_type = chat_unlock`.
* FeatureUnlock records the paid unlock, payment funding, unlock status, expiry, and revocation.
* ChatUnlock only marks that the matched chat has been unlocked.
* ChatUnlock must not duplicate payment or status state from FeatureUnlock.

### Match/User and ChatSafetyWarning

* Match has ChatSafetyWarnings per user.
* ChatSafetyWarning belongs to one User.

Rule:

* Show the chat unlock safety warning once per user.

## 6. Payment and Notification Relationships

### User and CreditAccount

* User has one CreditAccount.
* CreditAccount belongs to one User.

Rule:

* One user has one credit balance.

### CreditAccount and CreditTransaction

* CreditAccount has many CreditTransactions.
* CreditTransaction belongs to one CreditAccount.

Used for:

* Credit purchase
* Nakh spending
* Chat unlock spending
* Liked By unlock spending
* Refund
* Admin adjustment

Rules:

* When a successful credit-balance increase makes credits available, the system must attempt to settle that user’s unpaid PendingNakh queue.
* PendingNakhes are considered in ascending `created_at` order.
* Each successful settlement creates the normal Nakh-spending CreditTransaction and delivered Nakh.
* Settlement stops when the queue is empty or the next PendingNakh cannot be fully funded.

### User and CreditTransaction

* User has many CreditTransactions.
* CreditTransaction belongs to one User.

Purpose:

* Makes user payment history easy to query.

### CreditPackage and PaymentRecord

* CreditPackage can be purchased through many PaymentRecords.
* PaymentRecord may reference one CreditPackage.

Used when:

* User buys credits through Telegram Stars.

### User and PaymentRecord

* User has many PaymentRecords.
* PaymentRecord belongs to one User.

PaymentRecord stores:

* Payment attempt
* Payment status
* Provider
* Amount
* Result

### PaymentRecord and TelegramStarsPayment

* PaymentRecord has one TelegramStarsPayment.
* TelegramStarsPayment belongs to one PaymentRecord.

Purpose:

* Separates internal payment state from Telegram-specific payment data.

### PaymentRecord and PaymentProviderEvent

* PaymentRecord can have many PaymentProviderEvents.
* PaymentProviderEvent may belong to one PaymentRecord.

Purpose:

* Stores raw Telegram callbacks/events.
* Prevents duplicate processing.
* Supports audit and debugging.

### User and PendingPayment

* User has many PendingPayments.
* PendingPayment belongs to one User.

Used for:

* Pending Nakh payment
* Pending chat unlock
* Pending Liked By unlock
* Credit package purchase

### PendingPayment and PaymentRecord

* PendingPayment can create one PaymentRecord.
* PaymentRecord may complete one PendingPayment.

Rule:

* Pending payment becomes paid, failed, cancelled, or expired.

### PaymentRecord and CreditTransaction

* PaymentRecord can create one or more CreditTransactions.
* CreditTransaction may reference one PaymentRecord.

Examples:

* Buy credits creates a credit transaction.
* Spend credits creates a debit transaction.
* Refund creates a refund transaction.

### FeatureUnlock and PaymentRecord

* FeatureUnlock may reference one PaymentRecord.
* PaymentRecord may create one FeatureUnlock.

Used when:

* Payment directly unlocks a feature.

### FeatureUnlock and CreditTransaction

* FeatureUnlock may reference one CreditTransaction.
* CreditTransaction may fund one FeatureUnlock.

Used when:

* User spends existing credits to unlock a feature.

### FeatureUnlock and Like

* FeatureUnlock can unlock one liked-by Like.
* Like can have one Liked By unlock for a specific receiver.

Rule:

* Unlocking one Liked By profile does not unlock other Likes.

### FeatureUnlock and Match / ChatUnlock

* FeatureUnlock can unlock one Match chat.
* ChatUnlock belongs to one FeatureUnlock.
* ChatUnlock belongs to one Match.

Rules:

* Chat unlock is scoped to one Match.
* One successful chat unlock payment unlocks free-text chat for both users in that Match.
* If one user unlocks chat, both users can send text in that Match.
* The other matched user does not need to pay again for the same Match.
* Chat unlock does not expire in MVP.
* Chat unlock remains active until the Match is unmatched, closed by admin/moderation, or closed because of account deletion or ban.
* For chat unlock, FeatureUnlock is the access/payment source of truth.
* ChatUnlock is only the Match-level chat marker connected to that FeatureUnlock.
* Chat access should be allowed only when the related FeatureUnlock is active and the Match/ChatSession is still active.

Ownership rule:

* `FeatureUnlock.payer_user_id` records who paid.
* `FeatureUnlock.match_id` records which Match was unlocked.
* For chat unlock, access checks must be based on the Match/ChatUnlock, not on `payer_user_id`.

### FeatureUnlock and Nakh

* FeatureUnlock is not needed for normal sent Nakh.
* Nakh payment is tracked through PaymentRecord and CreditTransaction.

Reason:

* Nakh is a paid action, not a persistent access unlock.

### PaymentRecord and RefundRecord

* PaymentRecord can have one or more RefundRecords.
* RefundRecord belongs to one PaymentRecord.

Used for:

* Payment correction
* Manual refund
* Failed dispute handling

### User and Notification

* User has many Notifications.
* Notification belongs to one User.

Notification belongs to the receiver of the notice.

### Notification and NotificationDelivery

* Notification can have many NotificationDeliveries.
* NotificationDelivery belongs to one Notification.

Used for:

* In-app notification
* Telegram message delivery
* Retry tracking
* Failure tracking

### User and NotificationPreference

* User has one NotificationPreference.
* NotificationPreference belongs to one User.

Rule:

* Normal notifications can be muted.
* Safety, payment, admin, ban, and restriction notices cannot be muted.

### Like and Notification

* Like can create one Notification for the receiver.
* Notification may reference one Like in payload.

Rule:

* Normal Like creates a Liked By notification.

### Nakh and Notification

* Sent Nakh can create one Notification for the receiver.
* Notification may reference one Nakh in payload.

Rules:

* Only paid Sent Nakh creates receiver notification.
* PendingNakh creates no receiver notification.

### Match and Notification

* Match creates Notifications for both users.
* Notification may reference one Match in payload.

### ChatMessage and Notification

* ChatMessage can create one Notification for the receiver.
* Notification may reference one ChatMessage in payload.

Rule:

* Chat notifications respect mute settings unless they are safety/admin notices.

### PaymentRecord and Notification

* PaymentRecord can create payment success/failure Notification.
* Notification may reference one PaymentRecord in payload.

Rule:

* Payment notices cannot be muted.

## 7. Moderation, Admin, Support, Audit, Jobs, and Localization Relationships

### User and Report

* User has many submitted Reports as reporter.
* User has many received Reports as target.
* Report connects reporter_user_id and target_user_id.

Rules:

* Report connects one reporter user to one target user.
* Report threshold counting is based on unique `reporter_user_id` values for the same `target_user_id`.
* Multiple reports from the same reporter against the same target user count as 1 reporter for automatic restriction.
* The automatic restriction threshold is evaluated at target-user level.
* ReportEvidence does not create separate threshold buckets.
* Profile, photo, chat/message, and unmatched-user evidence types all count toward the same target-user report threshold.
* For MVP, 5 or more unique reporters within a rolling 30-day window triggers automatic restriction if the reports are unresolved.
* Only reports with status `submitted` or `pending_review` count toward automatic restriction.
* Reports with status `dismissed`, `closed`, or `actioned` do not count toward triggering a new automatic restriction.
* Reports do not automatically ban users.
* Ban requires admin decision.

### Report and ReportReason

* Report belongs to one ReportReason.
* ReportReason can be used by many Reports.

Default reasons:

* Fake profile
* Harassment
* Inappropriate photo
* Spam or scam
* Under 18
* Offensive behavior
* Other

### Report and ReportEvidence

* Report has one or more ReportEvidence records.
* ReportEvidence belongs to one Report.

Evidence types:

* Profile
* Photo
* Chat
* Message
* Unmatched user

### ReportEvidence and UnmatchRecord

* ReportEvidence can belong to one UnmatchRecord when the evidence type is `unmatched_user`.
* UnmatchRecord can be referenced by many ReportEvidence records.

Rules:

* This relationship is required for post-unmatch reports.
* The referenced UnmatchRecord is the source of truth for the 24-hour post-unmatch report window.
* The system must reject unmatched-user reports if the current time is after `UnmatchRecord.report_window_expires_at`.
* The reporter and reported user must both belong to the referenced UnmatchRecord.

### Report and ReportSnapshot

* Report has one or more ReportSnapshots.
* ReportSnapshot belongs to one Report.

Purpose:

* Freezes reported context at report time.
* Prevents evidence loss after profile edits, photo changes, or chat cleanup.

### Report and ModerationReview

* Report can have one ModerationReview.
* ModerationReview belongs to one Report.

Used when admin starts reviewing the report.

### ModerationReview and ModerationAction

* ModerationReview can result in one or more ModerationActions.
* ModerationAction may belong to one ModerationReview.

Examples:

* Dismiss report
* Restrict user
* Ban user
* Hide photo
* Restore photo
* Delete photo

### AdminUser and ModerationReview

* AdminUser can review many ModerationReviews.
* ModerationReview belongs to one reviewing AdminUser.

### AdminUser and ModerationAction

* AdminUser can perform many ModerationActions.
* ModerationAction belongs to one AdminUser.

### AdminUser and AdminRole

* AdminUser can have one or more AdminRoles.
* AdminRole can belong to many AdminUsers.
* AdminUserRole connects AdminUser and AdminRole.

### AdminRole and AdminPermission

* AdminRole has many AdminPermissions.
* AdminPermission can belong to many AdminRoles.
* AdminRolePermission connects AdminRole and AdminPermission.

### AdminUser and AdminActionLog

* AdminUser has many AdminActionLogs.
* AdminActionLog belongs to one AdminUser.

Rule:

* Every admin action must be logged.

### ProfilePhoto and Report

* ProfilePhoto can be reported by many Reports.
* ReportEvidence may reference one ProfilePhoto.

### ProfilePhoto and ModerationAction

* ProfilePhoto can be hidden, restored, or deleted by ModerationAction.
* ModerationAction may target one ProfilePhoto.

Rules:

* If the hidden or deleted photo is primary, another visible photo should become primary if available.
* If no visible primary photo can be assigned, profile validity must be rechecked.
* Admin photo deletion is soft deletion from the dating profile and does not immediately hard-delete the underlying MediaAsset.

### ChatSession / ChatMessage and Report

* ChatSession can be referenced by ReportEvidence.
* ChatMessage can be referenced by ReportEvidence.

When chat is reported:

* Create ReportSnapshot.
* Create ChatMessageSnapshot.

### User and SupportThread

* Non-banned User has many SupportThreads.
* SupportThread belongs to one User.

Rule:

* Banned users cannot create SupportThread records.
* Banned users must use UserAppeal for ban appeals.

### SupportThread and SupportMessage

* SupportThread has many SupportMessages.
* SupportMessage belongs to one SupportThread.

Rule:

* Support messages must be rate-limited.

### User and UserAppeal

* Banned User can have UserAppeals.
* UserAppeal belongs to one User.
* UserAppeal belongs to one ban AccountStateHistory record through `ban_state_history_id`.

Rules:

* UserAppeal is the canonical banned-user appeal mechanism.
* Banned users cannot create SupportThread or SupportMessage records.
* One UserAppeal is allowed per ban event.
* A user cannot create more than one UserAppeal for the same `ban_state_history_id`.

### AdminUser and UserAppeal

* AdminUser can review many UserAppeals.
* UserAppeal may be reviewed by one AdminUser.

### User / AdminUser and AuditLog

* AuditLog may reference actor_user_id.
* AuditLog may reference actor_admin_id.
* AuditLog may reference a target entity.

Purpose:

* Tracks important account, profile, payment, safety, and admin events.

### PaymentRecord and PaymentAuditLog

* PaymentRecord has many PaymentAuditLogs.
* PaymentAuditLog belongs to one PaymentRecord.

### Report / User and SafetyAuditLog

* SafetyAuditLog may reference one User.
* SafetyAuditLog may reference one Report.

Used for:

* Restriction
* Ban
* Report threshold
* Photo hiding
* Appeal review

### User and DataRetentionRecord

* User can have many DataRetentionRecords.
* DataRetentionRecord belongs to one User.

Used after account deletion only for safety, abuse prevention, moderation, restriction/ban enforcement, and required safety evidence.

DataRetentionRecord must not be used to restore normal deleted product data.

### ScheduledJob and JobRunLog

* ScheduledJob has many JobRunLogs.
* JobRunLog belongs to one ScheduledJob.

Examples:

* Expire Nakh
* Expire pending payment
* Send payment reminder
* Cleanup chat messages
* Retry notification delivery

### Locale and UIText

* Locale has many UIText records.
* UIText belongs to one Locale.

Rule:

* Bot handlers use text keys.
* Handlers should not contain hardcoded user-facing text.

## 8. Notes

* These are domain relationships, not final database foreign keys.
* Database-level constraints will be defined later.
* UserPairState is a current-state summary and does not replace source entities.
* ReportSnapshot and ChatMessageSnapshot preserve moderation evidence.
* FeatureUnlock handles paid access, while payment records handle payment lifecycle.
* PendingNakh and Nakh have different visibility and delivery rules.
* ChatSession must belong to Match.
* No Match means no ChatSession.








