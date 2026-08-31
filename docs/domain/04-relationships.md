# Domain Relationships and Lifecycles

This document defines cardinality and the order of stateful workflows. Permissions and transactional invariants are canonical in `06-business-rules-and-invariants.md`.

## 1. Relationship map

### Identity and account

- User has exactly one TelegramIdentity.
- User has exactly one Account, UserSettings, GuestPreviewCounter, and CreditAccount.
- User has many AccountStateHistory and AccountDeletionRecord records.
- User has at most one current SignupProgress, SignupDraft, Profile, ExploreFilter, and NotificationPreference.
- A deleted User may later own a new Profile, but a deleted Profile is never restored.

### Profile and catalogs

- GenderPreference has many GenderOptions through GenderPreferenceMember.
- Profile belongs to one GenderOption and one GenderPreference.
- Profile has zero or one ProfileOptionalDetails.
- Profile has many Interests, Languages, and PersonalityTags through unique join entities.
- Profile belongs to one Country, Province, and City; the City must belong to the Province and the Province to the Country.
- A User has many ProfileChangeRequests; each request has at most one ProfileChangeReview.

### Media

- User owns many MediaAssets.
- Profile has many ProfilePhotos.
- ProfilePhoto belongs to one MediaAsset, and one MediaAsset can back at most one active ProfilePhoto.
- MediaAsset has at most one PhotoVariant of each variant type.
- ProfilePhoto has many PhotoModerationRecords.

### Discovery and pair interaction

- User has many ExploreConsumptions as viewer and as target.
- User has many sent and received Likes, NotInterested records, NakhFlows, and Nakhes.
- A normalized user pair has at most one UserPairState and at most one Match during the current account lifetime.
- FeatureUnlock belongs to one payer and exactly one Like or Match scope.

### Nakh

- NakhFlow belongs to one sender and one receiver.
- NakhFlow has at most one PendingNakh and at most one delivered Nakh.
- A PendingNakh may have one current PendingPayment and multiple provider PaymentRecord attempts.
- Nakh has many NakhStatusHistory and NakhReceiverAction records.
- An accepted Nakh may create one Match.

### Match and chat

- Match has exactly two MatchParticipants.
- Match has exactly one ChatSession.
- Match has at most one UnmatchRecord.
- ChatSession has exactly two ChatParticipants and many ChatMessages.
- A ChatMessage may be copied to many ChatMessageSnapshots when separately reported.
- A Match has at most one successful chat FeatureUnlock.

### Payments and notifications

- CreditAccount has many CreditTransactions.
- CreditPackage has many PaymentRecords.
- PendingPayment may have multiple PaymentRecord attempts but can be successfully resolved only once.
- A successful PaymentRecord has one TelegramStarsPayment and may receive many PaymentProviderEvents.
- A paid action creates at most one Nakh, FeatureUnlock, or credit-package grant for its idempotency key.
- Notification has one or more NotificationDeliveries.

### Moderation and support

- Report links one reporter to one target and has one or more ReportEvidence records.
- Report has immutable ReportSnapshots where mutable context is relevant.
- Report has at most one ModerationReview and may lead to many ModerationActions.
- AdminUser has roles through AdminUserRole; roles have permissions through AdminRolePermission.
- Non-banned User has many SupportThreads and SupportMessages.
- One ban AccountStateHistory record has at most one UserAppeal.

## 2. First start and signup lifecycle

For a Telegram user ID not previously known:

1. Create User.
2. Create TelegramIdentity.
3. Create Account in `guest`.
4. Create default UserSettings and NotificationPreference.
5. Create GuestPreviewCounter at 0/10.
6. Create zero-balance CreditAccount.
7. Show Guest Preview and Sign Up choices.

For a known Telegram user ID, resolve the existing User first and route strictly from Account and Profile state.

When signup starts:

1. Transition Account `guest -> incomplete`.
2. Create or resume SignupProgress and SignupDraft.
3. Keep the existing GuestPreviewCounter unchanged.
4. Validate and store each draft step.
5. On confirmation, atomically create/update Profile and its selections, evaluate completion, mark signup completed, and transition Account `incomplete -> active`.

If confirmation fails, Account stays `incomplete` and the user resumes at the first invalid or missing step.

## 3. Profile completion and invalidation lifecycle

A never-completed Profile is `incomplete`.

On first successful completion:

1. Set `completion_status = complete`.
2. Set `ever_completed = true`.
3. Set `completed_at`.
4. Ensure Account is `active`.

After every change to a required field, interest selection, location, or photo visibility:

1. Re-evaluate all completion requirements.
2. If requirements pass, set `complete`.
3. If they fail and `ever_completed = false`, set `incomplete`.
4. If they fail and `ever_completed = true`, set `invalid`.

An invalid Profile never changes an active Account back to `incomplete`.

## 4. Photo lifecycles

### Upload

1. Receive a Telegram image transport reference.
2. Download to temporary processing storage.
3. Decode and validate real content, MIME type, size, dimensions, animation, and duplicate hashes.
4. Store the original in object storage and create a valid MediaAsset.
5. Generate and store the thumbnail.
6. Create a visible ProfilePhoto.
7. If it is the first visible photo, make it primary.
8. Re-evaluate Profile completion.
9. Clean temporary files.

Failure before step 6 creates no visible ProfilePhoto and does not consume a photo slot.

### User deletion

1. Prevent deletion if the photo is primary and no replacement primary was selected.
2. Remove the ProfilePhoto from user-facing surfaces.
3. If evidence retention is not required, permanently delete original and variants from storage/CDN.
4. If evidence is required, move/copy the minimum evidence to restricted storage and remove public delivery.
5. Mark cleanup timestamps and re-evaluate Profile completion.

### Admin moderation

- Hide: visible -> hidden; remove from user surfaces; retain restorable media.
- Restore: hidden -> visible if the moderation decision allows it.
- Delete: visible/hidden -> deleted; remove from Profile surfaces; retain restricted media only as permitted safety evidence.

If the primary photo stops being visible, atomically promote the lowest-order visible photo. If none exists, Profile completion becomes incomplete or invalid according to prior completion.

### Blurred preview

When a locked Liked By card is requested, locate the liker's current visible primary photo. Reuse its blurred variant or generate and cache one. Changing the primary photo naturally changes which MediaAsset requires the variant.

## 5. Explore and interaction lifecycle

### Candidate selection

1. Confirm viewer access.
2. Filter targets by Account, Profile completion, visibility, Iran location, pair state, and no prior consumption.
3. Apply reciprocal Profile relationship-preference compatibility.
4. Apply ExploreFilter, including the independent target-gender subset.
5. Select at most the configured candidate pool ordered by rotating shuffle key.
6. Shuffle that bounded set in application memory.
7. Immediately before display, recheck eligibility.
8. When the card is actually sent successfully, create ExploreConsumption with reason `preview`.

Creating a later Like, NotInterested, NakhFlow, or Match never creates a second viewer/target consumption. ExploreConsumption.reason records the first event that consumed the target; later actions are audited by their own entities.

### Like

1. Verify the pair is eligible for a new interaction.
2. Create Like and ensure ExploreConsumption.
3. If the reverse active Like exists, create Match through the mutual-Like transaction.
4. Otherwise create receiver Notification and enqueue Telegram delivery.

### Liked By

Liked By is queried from received active Likes and current account/profile/pair eligibility.

- Locked Like: show only count and blurred card.
- Paid unlock: create one Like-scoped FeatureUnlock and show the full Profile.
- Like Back: create the reverse Like and Match in one transaction.
- Not Interested: create NotInterested, close the received Like for inbox purposes, and remove the card.

Visibility or filter changes do not retract an already-sent Like. A Like becomes non-actionable when its sender is not active/complete, the receiver rejected it, or the pair is matched, unmatched, or blocked.

## 6. Nakh lifecycle

### Start with existing credits

1. Validate sender, receiver, pair, and text.
2. Create NakhFlow.
3. Atomically deduct 2 credits, create CreditTransaction, create delivered Nakh, ensure ExploreConsumption, create receiver Notification, and enqueue delivery.

### Start with direct Telegram Stars

1. Validate sender, receiver, pair, and text.
2. Show the user that Pending Nakh may later auto-settle from wallet funding.
3. On confirmation, create NakhFlow, PendingNakh, and PendingPayment; ensure ExploreConsumption.
4. Create a 2-Star invoice PaymentRecord.
5. Do not notify the receiver.
6. On a successful idempotent callback, recheck non-visibility eligibility and atomically create delivered Nakh, transition PendingNakh to `paid_and_sent`, create receiver Notification, and close the PendingPayment.

An unsuccessful invoice attempt does not by itself end PendingNakh. The sender may retry, edit text, cancel, or wait for expiry.

### FIFO auto-settlement

After any committed credit increase:

1. Lock the User's CreditAccount and pending queue.
2. Load `pending_payment` PendingNakhes oldest first.
3. Recheck sender/receiver non-visibility eligibility.
4. If the oldest eligible item can be fully funded, deliver it using the same credit transaction as a direct credit-funded Nakh.
5. Continue until the queue is empty or the next eligible item cannot be fully funded.

An ineligible PendingNakh is closed according to reason and any already captured funding is corrected; it does not allow a new NakhFlow.

### Cancellation

The sender must choose exactly one resolution:

- Convert to Like: create Like and its normal effects.
- Convert to Not Interested: create NotInterested without notifying the target.

Then set PendingNakh to `cancelled`. NakhFlow and ExploreConsumption remain.

### Receiver

- First view changes `sent -> seen`.
- Accept changes the Nakh to `accepted` and creates Match.
- Reject changes it to `rejected`; the UI label is “Closed.”
- Report creates the normal Report evidence and does not imply acceptance or rejection.
- No terminal receiver action may be applied twice.

## 7. Match, unmatch, and chat lifecycle

### Match creation

Mutual Like or Nakh acceptance uses one transaction to:

1. Create the normalized unique Match.
2. Set UserPairState to `matched`.
3. Close relevant Likes as `closed_by_match`.
4. Create two MatchParticipants.
5. Create one ChatSession and two ChatParticipants.
6. Create Notifications for both users.

### Chat

Without a Match-scoped FeatureUnlock, both participants may send only valid predefined question/answer messages.

On successful chat unlock:

1. Create one Match-scoped FeatureUnlock funded by credits or 4 Stars.
2. Mark both participants as allowed to send text through the effective unlock.
3. Show the safety warning once per participant.
4. Notify both participants.

MVP unlocks do not expire by time. Permission ends if the Match/ChatSession closes or the FeatureUnlock is revoked.

### Unmatch

In one transaction:

1. Change Match to `unmatched`.
2. Create UnmatchRecord with a 24-hour report deadline.
3. Change UserPairState to `unmatched`.
4. Close ChatSession with reason `unmatch`.
5. Close related Likes as `closed_by_unmatch`.
6. Notify the other participant that the chat closed.

Unmatch does not create NotInterested; UnmatchRecord and UserPairState are the canonical symmetric rejection.

## 8. Payment lifecycle

### Credit package

1. Load the active CreditPackage and its Stars price.
2. Create PendingPayment and PaymentRecord.
3. Send the Telegram invoice.
4. On the first valid success event, mark paid, add the configured credits, create a purchase CreditTransaction, notify the payer, and trigger FIFO settlement.

### Direct paid action

Direct payment uses the configured Stars price and resolves exactly one PendingPayment target. Its final product effect must be identical to credit funding.

### System-fault correction

If funding succeeded but the action did not:

- Refund a direct Stars charge through Telegram and record RefundRecord, or
- Restore internal credits with a refund CreditTransaction and RefundRecord.

Provider and correction callbacks are safe to replay.

## 9. Reporting and moderation lifecycle

Report creation:

1. Validate reporter, target, evidence relationship, rate limit, and optional text.
2. Create Report and evidence.
3. Snapshot mutable context in the same transaction.
4. Recalculate the target's unresolved unique-reporter threshold.
5. At 5 reporters in 30 days, create one system restriction action, transition Account to `restricted`, prioritize review, and notify the target.

Admin review may dismiss, keep restricted, unrestrict, ban, or take a photo action. Report status and Account transitions are separate and every admin attempt is logged.

Internal block is a deliberate safety action that closes any active Match/chat and sets UserPairState to `blocked`, which has precedence over `matched` or `unmatched`.

## 10. Account deletion and return lifecycle

Deletion:

1. Re-authenticate the Telegram identity through the current update context and request confirmation.
2. Transition Account to `deleted` and immediately remove discovery visibility.
3. Close active Matches/chats and stop pending deliveries.
4. Create AccountDeletionRecord.
5. Purge Profile, media not retained as evidence, filters, consumption, Likes, NotInterested, Nakh data, Matches, ordinary chat, credits, payments, FeatureUnlocks, normal Notifications, support data, and other ordinary product history.
6. Retain only User, TelegramIdentity, GuestPreviewCounter, Account/deletion history, and specifically justified safety/evidence data.
7. Complete and audit the purge.

Return:

1. Resolve the same TelegramIdentity and retained safety state.
2. If return is disallowed, keep Account deleted and show the limited return/appeal message.
3. If allowed, transition `deleted -> guest`, create fresh default product records as needed, keep the old GuestPreviewCounter, and start signup from zero.
4. Never restore old credits, payments, unlocks, Profile, interactions, Matches, or chats.
