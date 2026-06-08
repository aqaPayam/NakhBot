# Business Rules and Invariants

This file defines product rules that must always hold.

These rules cross multiple entities and should not be buried inside individual entity files.

## 1. Account and Access Rules

### Account states

A user account must be in one of these states:

* guest
* incomplete
* active
* restricted
* banned
* deleted

### Guest access

Guest users can:

* View limited profile previews
* Start signup

Guest users cannot:

* Use filters
* Like profiles
* Send Nakh
* Mark Not Interested
* Match
* Chat
* Use paid features

### Guest preview limit

Guest users can see only 10 profile previews permanently.

The preview counter is tied to the user/Telegram identity.

### Incomplete user access

Incomplete users are treated like guests until signup is completed.

Incomplete users share the same permanent preview counter as guests.

### Active user access

Active users can use normal product features if:

* Account state is `active`
* Profile completion status is `complete`
* User visibility is enabled where required

### Visibility off

If visibility is off:

* User does not appear in Explore
* User cannot Explore others
* User cannot Like
* User cannot send Nakh

Visibility off does not stop:

* Existing matches
* Existing chats
* Existing sent Nakh flows
* Existing pending Nakh payments

### Restricted user access

Restricted users can:

* Open the app
* Edit profile
* Read existing chats
* Contact support/admin

Restricted users cannot:

* Appear in Explore
* Explore others
* Like
* Send Nakh
* Send chat messages

### Banned user access

Banned users cannot use the app.

A banned user can send one limited appeal/support message.

### Deleted user access

Deleted users do not have normal access.

After deletion:

* Profile becomes hidden
* Chats close
* Minimal audit, report, payment, and safety records remain

A deleted user may later start a reactivation/signup flow using the same Telegram account.

## 2. Signup and Profile Rules

### Minimum age

Minimum allowed age is 18.

Users enter Gregorian birth year only.

Exact birth date is not collected.

Age verification is not included in MVP.

### Age calculation

Age is derived from Gregorian birth year.

Displayed age is approximate because exact birth date is not collected.

Age should not be stored as a separate source-of-truth field.

### Signup order

Signup follows this order:

1. Confirm age 18+
2. Name
3. Birth year
4. Gender
5. Interested gender
6. Interests
7. Country, province, and city
8. Relationship goal
9. Upload primary photo
10. Upload additional photos
11. Write highlight
12. Optional bio and optional profile details
13. Confirm profile

### Required profile fields

A profile cannot become complete unless it has:

* Name
* Gregorian birth year
* Gender
* Interested gender
* At least 5 profile interests
* Country
* Province
* City
* Relationship goal
* At least 2 visible photos
* At most 6 uploaded profile photos
* One visible primary photo
* Highlight

### Interest rules

A profile must have at least 5 interests to become complete.

A profile can have at most 20 interests.

Interests belong to the dating profile, not directly to the user.

### Highlight rules

Highlight is required.

Highlight maximum length is 80 characters.

### Bio rules

Bio is optional.

Bio maximum length is 500 characters.

### Locked profile fields

Birth year cannot be changed directly after signup.

Gender cannot be changed directly after signup.

To change either field, the user must submit a profile change request with a reason.

Admin can approve or reject the request.

### Interested gender

Interested gender can be changed later.

Changing interested gender from Explore filters or Edit Profile updates the same profile-level value.

### Profile and account separation

Profile data and account state must stay separate.

Profile owns dating-visible data.

Account owns access and lifecycle state.

## 3. Media and Photo Rules

### Photo source

Telegram profile photo must not be used as the dating profile photo.

Users must upload dating profile photos explicitly.

### Photo storage

Photos must be stored in object storage.

The app server must not be the permanent image store.

Photos should be served through CDN URLs.

### Photo count

A complete profile must have at least 2 visible photos.

A user can upload at most 6 profile photos.

Extra uploaded photos must be rejected.

Hidden or deleted photos do not count toward profile completion.

### Primary photo

One photo must always be primary.

The first uploaded photo becomes the primary photo.

The user cannot delete the primary photo before choosing another primary photo.

### Photo visibility

Photos are not pre-approved.

Uploaded photos become visible immediately.

Users can report photos.

Admin can hide or restore photos.

### Hidden primary photo

If admin hides a primary photo:

* Another visible photo should become primary if available.
* If no visible primary photo can be assigned, profile validity must be rechecked.
* If the profile was never completed and required photo rules are not satisfied, keep `Profile.completion_status = incomplete`.
* If the profile was previously complete and required photo rules are no longer satisfied, set `Profile.completion_status = invalid`.
* Do not use hidden as a profile completion status.

### Blurred previews

Locked Liked By cards require blurred photo previews.

Blurred previews should be generated as photo variants.

## 4. Explore and Consumption Rules

### Explore access

Only active users with complete profiles and visibility enabled can Explore.

Restricted, banned, deleted, incomplete, and visibility-off users cannot Explore.

### Explore display

Explore shows one profile at a time.

Explore preview includes:

* Primary photo
* Name
* Age
* City
* Highlight

### Eligible profile rules

A profile can appear in Explore only if:

* Profile completion status is `complete`
* User visibility is enabled
* Account state is `active`
* User is not restricted, banned, or deleted
* Profile is compatible with the viewer’s filters
* Target has not previously been consumed by the viewer

### Explore filters

MVP Explore filters include:

* Interested gender
* Age range
* Country
* Province
* City
* Relationship goal

Interested gender is stored on Profile.

Age range, location, and relationship goal are stored in ExploreFilter.

### Default filters

Default age range is:

* user age minus 5
* user age plus 5

Minimum age is always 18.

Default location is the user’s own city.

There is no whole-country filter in MVP.

Relationship goal filter is optional.

### Profile consumption

A profile is consumed after:

* Preview
* Like
* Not Interested
* Pending Nakh
* Sent Nakh
* Match

Consumed profiles must not be shown again to the same viewer.

### Guest and incomplete consumption

Guest and incomplete users also consume profile previews.

Their permanent preview counter is shared by Telegram identity/user.

### No results

If no eligible profile exists, show the Nobody Found state.

## 5. Like, Liked By, and Not Interested Rules

### Normal Like

A normal Like is free.

A normal Like appears in the receiver’s Liked By section.

A normal Like can create a Match if the receiver has already liked the sender.

### Liked By

Liked By shows users who sent normal Likes.

Liked By does not include Nakh senders.

### Locked Liked By view

Before unlock, the user can see:

* Number of Likes
* Locked liked-by cards
* Blurred preview image

Before unlock, the user cannot see:

* Full profile
* Profile details

### Liked By unlock

Each liked-by profile is unlocked separately.

Unlocking one liked-by profile does not unlock other liked-by profiles.

After unlock, the user can:

* View full profile
* Like Back
* Mark Not Interested

### Liked By unlock expiry

Liked By profile unlock expires according to configured unlock duration.

The expiry duration must be configurable and must not be hardcoded in handlers.

After expiry, the user should no longer have full unlocked access to that liked-by profile unless a valid active unlock still exists.

### Like Back from Liked By

If user Likes Back from Liked By, a Match is created.

After Match, the pair exits discovery actions.

### Not Interested

Not Interested is permanent.

A target marked as Not Interested should not appear again.

Not Interested can come from:

* Explore
* Liked By
* Cancelled Pending Nakh
* Unmatch

### Not Interested from Liked By

If user marks an unlocked Liked By profile as Not Interested:

* Create NotInterested pair record
* Hide/close that liked-by card from default view
* Do not notify the target

## 6. Nakh Rules

### Nakh meaning

Nakh is a paid stronger signal.

Nakh is separate from normal Like.

### Pending Nakh

Pending Nakh is an unpaid Nakh attempt.

Pending Nakh is visible only to the sender.

Pending Nakh does not:

* Notify the receiver
* Create normal Like
* Appear in Liked By
* Appear in receiver’s Nakhes
* Create Match

Pending Nakh does consume the target profile.

### Pending Nakh payment

If the sender does not have enough credits:

* Create PendingNakh
* Create PendingPayment
* Allow editing Nakh text before payment
* Do not notify receiver

### Pending Nakh cancellation

If sender cancels unpaid Pending Nakh, ask whether to:

* Convert to normal Like
* Mark as Not Interested

If converted to normal Like:

* Create Like
* Notify target
* Show sender in target’s Liked By
* Create Match if reverse Like exists

If converted to Not Interested:

* Create NotInterested
* Do not notify target
* Keep target consumed

### Sent Nakh

Sent Nakh is created only after payment succeeds or credits are successfully spent.

Sent Nakh appears in receiver’s Nakhes.

Sent Nakh does not appear in receiver’s Liked By.

### Nakh delivery

When Nakh is successfully sent:

* Deduct credits or confirm payment
* Create Nakh
* Notify receiver
* Show Nakh in receiver’s Nakhes

### Nakh limits

Only one Nakh can be sent per sender/receiver pair.

Nakh text maximum length is 240 characters.

Nakh expires after 14 days.

### Nakh receiver actions

Receiver can:

* View profile
* Accept Nakh
* Reject
* Report

### Nakh rejection

Rejected Nakh is internally stored as rejected or closed.

UI should show rejected Nakh as Closed.

If receiver rejects Nakh:

* Nakh closes
* Sender cannot send another Nakh to the same target
* Receiver should stop seeing sender in this flow

### Nakh acceptance

If receiver accepts a sent Nakh:

* Create Match
* Notify both users
* Create ChatSession
* Stop discovery actions between the pair

## 7. Match and Unmatch Rules

### Match creation

A Match can be created by:

* Mutual normal Like
* Accepted Nakh

### Match uniqueness

A pair of users should not have duplicate active Matches.

The pair should be normalized to prevent duplicate pair records.

### Match effects

After Match:

* Users cannot Like each other again
* Users cannot send Nakh to each other
* Users cannot mark each other Not Interested
* Users cannot appear to each other in Explore
* ChatSession is created

### Match notification

When a Match is created:

* Both users receive a notification
* Internal bot relay chat becomes available

### Unmatch

Either matched user can unmatch.

When unmatch happens:

* Match becomes unmatched
* Chat closes visually for both users
* Other side receives a chat closed message
* Pair should not match again

### Unmatch as rejection

Unmatch acts like rejection.

After unmatch, the pair should not return to discovery, Like, Nakh, or Match flows.

### Post-unmatch report window

After unmatch, either user can report the other for 24 hours.

After the 24-hour window expires, the special unmatched-user report access should close.

### Message retention after unmatch

After unmatch:

* Chat closes visually
* Last 50 messages may be retained internally
* Report snapshots may preserve relevant messages for moderation

## 8. Chat Rules

### Chat creation

Chat exists only after Match.

No Match means no ChatSession.

### Chat type

Chat is internal bot relay chat.

It is not native Telegram direct messaging.

### Free chat mode

Before chat unlock, users cannot type freely.

Free matched users can only send:

* Predefined questions
* Predefined answers

Free matched users cannot send:

* Custom text
* Photos
* Stickers
* Media
* Emojis as custom free messages

### Predefined chat data

Predefined questions and answers must be data-driven.

They must not be hardcoded inside chat logic.

Default predefined topics:

* Relationship intent
* Ideal first date
* Chat frequency
* Introvert/extrovert
* Weekend habits
* Calls or texting
* Important values
* Meeting in person
* Relationship pace
* Current life focus

### Chat unlock

Chat unlock is paid per Match.

If either side unlocks chat, both users can send text in that Match.

Chat unlock remains active until the Match closes, the unlock is revoked, or a configured expiry is reached.

Chat unlock expiry behavior must be configurable and must not be hardcoded in handlers.

### Unlocked chat limits

After chat unlock:

* Text messages are allowed
* Photo messages are not allowed
* Sticker messages are not allowed
* Media messages are not allowed

### Contact sharing after unlock

After chat unlock, users may share:

* Phone number
* Telegram ID
* Other contact information

A safety warning must be shown once when chat unlocks.

### Chat message retention

Only the last 50 visible messages per chat should remain available in normal chat view.

Older messages may be archived or cleaned by background job.

Reported messages must be snapshotted before cleanup when needed for moderation.

### Restricted user chat access

Restricted users can read existing chats.

Restricted users cannot send chat messages.

### Deleted or banned user chat effect

If an account is deleted or banned, related chats should close visually according to account lifecycle rules.

## 9. Payment and Credit Rules

### Payment provider

MVP payment provider is Telegram Stars.

### Credits

Credits are the internal unit used for paid actions.

Paid actions include:

* Send Nakh
* Unlock one match chat
* Unlock one Liked By profile

### Credit balance

Each user has one credit balance.

Every credit balance change must create a CreditTransaction.

### Paid feature costs

MVP costs:

* Send Nakh: 2 credits
* Unlock one match chat: 4 credits
* Unlock one Liked By profile: 4 credits

### Credit packages

Users can buy credit packages.

Exact package sizes and discount rules are not finalized yet.

### Contextual purchase

Wallet is not shown in the MVP main menu.

Paid flows appear contextually when the user attempts a paid action.

### Paid action funding

Paid actions can be funded in either of these ways:

* Spending existing internal credits
* Direct Telegram Stars payment

Both funding paths must result in the same final domain action.

Direct Telegram Stars payment must not create different product behavior from credit-based payment.

Payment callbacks must be idempotent and must not double-process credits, unlocks, Nakh delivery, or notifications.

### Pending payment

A PendingPayment is created when a paid action cannot be completed immediately.

Pending payments should expire.

Pending payment completion must apply the related paid action exactly once.

### Payment idempotency

Payment callbacks must be idempotent.

The same provider payment event must not be processed twice.

Duplicate payment callbacks must not create:

* Duplicate credits
* Duplicate unlocks
* Duplicate Nakh delivery
* Duplicate notifications

### Credit spending

Credit spending must be transactional with the paid action.

For example, sending paid Nakh must:

* Check credit balance
* Deduct credits
* Create CreditTransaction
* Create Nakh
* Create receiver notification

The operation should either fully succeed or fully fail.

### Feature unlocks

FeatureUnlock is used for scoped paid access.

FeatureUnlock is used for:

* Liked By profile unlock
* Chat unlock

FeatureUnlock is not needed for sent Nakh.

Nakh is a paid action, not persistent access.

### Liked By unlock

Unlocking one Liked By profile unlocks only that specific profile.

It does not unlock other Liked By profiles.

### Chat unlock

Unlocking one match chat unlocks that specific match chat.

If one side unlocks chat, both sides can send text in that match.

### Payment audit

Payment lifecycle events must be auditable.

Payment audit should cover:

* Payment creation
* Payment success
* Payment failure
* Credit purchase
* Credit spending
* Refund or correction
* Provider callback processing

## 10. Notification Rules

### Notification history

Notifications must be stored.

Notification center keeps notification history with read/unread state.

### Telegram delivery

Important notifications should also be delivered through Telegram messages.

### Normal Like notification

Normal Like creates a notification for the receiver.

The sender appears in receiver’s Liked By.

### Nakh notification

Only paid Sent Nakh creates a receiver notification.

Pending Nakh creates no receiver notification.

Sent Nakh appears in receiver’s Nakhes, not Liked By.

### Match notification

When a Match is created:

* Both users receive a notification
* Chat becomes available

### Chat message notification

New chat messages can create notifications for the receiver.

Chat notifications should respect mute settings unless the message is safety/admin-related.

### Chat unlock notification

When chat is unlocked:

* Both users may be notified
* Chat mode changes to unlocked text
* Safety warning should be shown once

### Liked By unlock notification

When a user unlocks one Liked By profile, the unlock result should be recorded.

Notification may be shown to the unlocking user.

### Payment notification

Payment success and failure notices must be shown to the payer.

Payment notices cannot be muted.

### Safety and admin notices

These notification types cannot be muted:

* Safety notices
* Payment notices
* Admin notices
* Ban notices
* Restriction notices

### Normal notification mute

Users can mute normal notifications.

Normal mute can apply to:

* Chat notifications
* Like notifications
* Nakh notifications
* Match notifications

### Notification delivery retry

Failed notification delivery should be retryable when appropriate.

Delivery attempts should be tracked separately from the stored notification.

## 11. Reporting, Moderation, and Admin Rules

### Reportable targets

Users can report:

* Profile
* Photo
* Chat/message context
* Recently unmatched user within the allowed report window

### Report reasons

Default report reasons:

* Fake profile
* Harassment
* Inappropriate photo
* Spam or scam
* Under 18
* Offensive behavior
* Other

Reports may include optional extra text.

### Report review

Every report goes to admin review.

A report alone does not automatically ban a user.

### Report threshold

Five or more unique reporters should restrict the target until admin review.

The threshold should count unique reporters, not total report count.

### No automatic ban

There is no automatic ban in MVP.

Ban requires admin decision.

### Report snapshots

Reports should preserve relevant context at report time.

Snapshots may include:

* Profile data
* Photo data
* Chat messages
* Message context

Report snapshots should be immutable.

### Chat review privacy

Admins should see chat messages only when:

* A report is submitted
* Chat review is needed for moderation

Reported chat messages should be snapshotted.

### Photo moderation

Photos are not pre-approved.

Photos become visible immediately after upload.

Admin can hide or restore photos.

If a hidden photo is primary, another visible photo should become primary if available.

If required photo rules are no longer satisfied after photo moderation:

* A never-completed profile stays `incomplete`.
* A previously complete profile becomes `invalid`.

### Admin interface

MVP admin interface is Telegram admin commands.

No web admin panel is required for MVP.

### Admin capabilities

Admin can:

* View reports
* View user profile
* Restrict user
* Unrestrict user
* Ban user
* Unban user
* Hide photo
* Restore photo
* Dismiss report
* Review birth year change requests
* Review gender change requests
* Review appeals/support messages

### Admin logging

Every admin action must be logged.

Admin logs should include:

* Admin user
* Action type
* Target user/entity
* Timestamp
* Metadata when needed

## 12. Deletion, Retention, and Audit Rules

### Account deletion

Users can delete their account.

After deletion:

* Profile becomes hidden
* Chats close
* Account enters deleted state
* Minimal audit, report, payment, and safety records remain

### Reactivation

A deleted user may later create a new profile with the same Telegram account.

Exact reactivation flow is not finalized yet.

### Data retention

After deletion, retain only minimal records needed for:

* Payment safety
* Report history
* Abuse prevention
* Auditability
* Legal/accounting traceability

### Audit requirements

Important state-changing actions must be auditable.

Audit should cover:

* Account state changes
* Profile deletion
* Payment events
* Credit spending
* Feature unlocks
* Report submission
* Restriction
* Ban
* Photo hiding
* Chat closure
* Admin actions

## 13. Localization and Config Rules

### User-facing text

User-facing bot text should not be hardcoded inside handlers.

Text should be loaded through localization keys.

### MVP language

MVP language is English.

Persian and other languages may be added later.

### Localization coverage

Localization should cover:

* Button labels
* Bot messages
* Error texts
* Admin texts
* Payment texts
* Notification texts
* Safety texts

### Product constants

Product constants should not be scattered through handlers.

Configurable constants include:

* Guest preview limit
* Minimum signup age
* Minimum profile photos
* Maximum profile photos
* Minimum interests
* Maximum interests
* Highlight max length
* Bio max length
* Nakh text max length
* Nakh expiry days
* Nakh cost
* Chat unlock cost
* Liked By unlock cost

## 14. Notes

* These rules are product invariants.
* Database schema, constraints, and indexes must enforce these rules where possible.
* Application services must enforce rules that cannot be fully enforced at database level.
* Permission checks should be centralized.
* Payment and credit operations must be transactional.
* Nakh, Like, Match, and Chat rules must stay consistent across Explore, Liked By, Nakhes, and Chat flows.
* The final database design must be checked against this file before coding starts.










